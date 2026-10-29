import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../shared/prisma.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/error.js";
import { formatClock, toSkipTake, type Pagination } from "../../shared/validation.js";
import { generateSeats } from "./seat-layout.js";
import type { CoachInput, CreateTrainInput, RouteStopInput } from "./trains.schemas.js";

// What a train looks like in API responses. Defining the query shape once (and deriving the type
// from it with Prisma.TrainGetPayload) keeps the query and the code that formats it in sync.
const trainDetailsInclude = {
    routeStops: {
        orderBy: { sequence: "asc" },
        include: { station: { select: { code: true, name: true, city: true } } },
    },
    coaches: {
        orderBy: { code: "asc" },
        select: { code: true, class: true, _count: { select: { seats: true } } },
    },
} satisfies Prisma.TrainInclude;

type TrainWithDetails = Prisma.TrainGetPayload<{ include: typeof trainDetailsInclude }>;

// --------------------------------------------------------------------------- read

export async function listTrains(pagination: Pagination) {
    // Array form of $transaction: both queries run in one transaction, so `total` matches the page.
    const [trains, total] = await prisma.$transaction([
        prisma.train.findMany({ orderBy: { number: "asc" }, ...toSkipTake(pagination) }),
        prisma.train.count(),
    ]);
    return {
        items: trains.map((t) => ({
            id: t.id,
            number: t.number,
            name: t.name,
            runningDays: t.runningDays,
            departureTime: formatClock(t.departureMinutes),
        })),
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
    };
}

export async function getTrainByNumber(number: string) {
    const train = await prisma.train.findUnique({ where: { number }, include: trainDetailsInclude });
    if (!train) throw new NotFoundError(`Train ${number}`);
    return toTrainDetails(train);
}

async function getTrainById(id: string) {
    const train = await prisma.train.findUnique({ where: { id }, include: trainDetailsInclude });
    if (!train) throw new NotFoundError("Train");
    return toTrainDetails(train);
}

// --------------------------------------------------------------------------- write

export async function createTrain(input: CreateTrainInput) {
    try {
        const train = await prisma.train.create({
            data: {
                number: input.number,
                name: input.name,
                runningDays: input.runningDays,
                departureMinutes: input.departureTime,
            },
        });
        return getTrainById(train.id);
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new ConflictError(`Train ${input.number} already exists`);
        }
        throw err;
    }
}

// Replaces the whole route in one transaction: readers see either the old route or the new one,
// never a half-written mix.
export async function replaceRoute(trainId: string, stops: RouteStopInput[]) {
    await prisma.$transaction(async (tx) => {
        await assertTrainExists(tx, trainId);

        // Bookings point at specific route stops ("boarding at Kota"). Changing the route under them
        // would silently change what people bought, so refuse once anyone has booked.
        const bookings = await tx.booking.count({ where: { schedule: { trainId } } });
        if (bookings > 0) {
            throw new ConflictError("This train has bookings; its route can no longer be changed");
        }

        // Admins send station codes ("NDLS"); the table stores station IDs, so look them all up at once.
        const codes = stops.map((s) => s.stationCode);
        const stations = await tx.station.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
        const idByCode = new Map(stations.map((s) => [s.code, s.id]));
        const unknown = codes.filter((code) => !idByCode.has(code));
        if (unknown.length > 0) {
            throw new BadRequestError("UNKNOWN_STATION", `Unknown station code(s): ${unknown.join(", ")}`);
        }

        await tx.routeStop.deleteMany({ where: { trainId } });
        await tx.routeStop.createMany({
            data: stops.map((stop, index) => ({
                trainId,
                stationId: idByCode.get(stop.stationCode)!, // ! is safe: we just checked none are missing
                sequence: index + 1,
                arrivalMinutes: stop.arrivalMinutes,
                departureMinutes: stop.departureMinutes,
                distanceKm: stop.distanceKm,
            })),
        });
    });
    return getTrainById(trainId);
}

// Replaces all coaches and generates their seats from the standard layouts.
export async function replaceCoaches(trainId: string, coaches: CoachInput[]) {
    await prisma.$transaction(async (tx) => {
        await assertTrainExists(tx, trainId);

        // Each schedule's seat inventory was counted from these coaches. Changing them afterwards would
        // leave inventory claiming seats that don't exist (or missing seats that do).
        const schedules = await tx.trainSchedule.count({ where: { trainId } });
        if (schedules > 0) {
            throw new ConflictError("This train already has schedules; its coaches can no longer be changed");
        }

        await tx.seat.deleteMany({ where: { coach: { trainId } } });
        await tx.coach.deleteMany({ where: { trainId } });
        for (const coach of coaches) {
            // Nested write: create the coach and its 72 seats in one call. Prisma fills in coachId.
            await tx.coach.create({
                data: {
                    trainId,
                    code: coach.code,
                    class: coach.class,
                    seats: { createMany: { data: generateSeats(coach.class) } },
                },
            });
        }
    });
    return getTrainById(trainId);
}

// --------------------------------------------------------------------------- helpers

async function assertTrainExists(tx: Prisma.TransactionClient, trainId: string) {
    const train = await tx.train.findUnique({ where: { id: trainId }, select: { id: true } });
    if (!train) throw new NotFoundError("Train");
}

// Stop times are stored as "minutes after origin departure". For people, turn them into a clock
// time plus a day number: a stop 1 day and 2 hours in is { time: "18:55", day: 2 }.
function atStop(train: TrainWithDetails, minutesAfterDeparture: number | null) {
    if (minutesAfterDeparture === null) return null;
    const absolute = train.departureMinutes + minutesAfterDeparture;
    return { time: formatClock(absolute), day: Math.floor(absolute / 1440) + 1 };
}

function toTrainDetails(train: TrainWithDetails) {
    return {
        id: train.id,
        number: train.number,
        name: train.name,
        runningDays: train.runningDays,
        departureTime: formatClock(train.departureMinutes),
        route: train.routeStops.map((stop) => ({
            sequence: stop.sequence,
            station: stop.station,
            arrival: atStop(train, stop.arrivalMinutes),
            departure: atStop(train, stop.departureMinutes),
            distanceKm: stop.distanceKm,
        })),
        coaches: train.coaches.map((coach) => ({ code: coach.code, class: coach.class, seats: coach._count.seats })),
    };
}
