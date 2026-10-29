// Train search ("which trains go from A to B on this date?") and per-schedule availability.
// Both only read. The counts they show can be out of date a moment later; booking (Phase 4)
// re-checks them inside a locked transaction, so a stale count here can never oversell a seat.

import type { CoachClass, Quota } from "../../generated/prisma/client.js";
import { prisma } from "../../shared/prisma.js";
import { BadRequestError, NotFoundError } from "../../shared/error.js";
import { addDays, formatClock, todayUtc, toIsoDate } from "../../shared/validation.js";
import { CLASS_ORDER, availabilityOf, fareFor, isBookable } from "./availability.js";
import type { AvailabilityQuery, SearchTrainsInput } from "./trains.schemas.js";

const MINUTES_PER_DAY = 1440;

// When a stop happens, as a calendar date and a clock time. `minutesAfterDeparture` is the stop
// time stored on RouteStop; adding the origin departure gives minutes after midnight on the
// journey date, which can run past 1440 into the following days.
export function moment(journeyDate: Date, trainDepartureMinutes: number, minutesAfterDeparture: number) {
    const absolute = trainDepartureMinutes + minutesAfterDeparture;
    return {
        date: toIsoDate(addDays(journeyDate, Math.floor(absolute / MINUTES_PER_DAY))),
        time: formatClock(absolute),
    };
}

// Timetable clock times are Indian Standard Time (UTC+05:30, no daylight saving). journeyDate is
// stored as midnight UTC of that calendar day, so midnight IST is 5 h 30 min earlier.
const IST_OFFSET_MINUTES = 330;

// The same moment as an absolute instant, for "how long until departure" (refund rules, chart time).
export function departureInstant(journeyDate: Date, trainDepartureMinutes: number, minutesAfterDeparture: number): Date {
    return new Date(journeyDate.getTime() + (trainDepartureMinutes + minutesAfterDeparture - IST_OFFSET_MINUTES) * 60_000);
}

const byClassOrder =(a: { class: CoachClass }, b: { class: CoachClass }) =>
    CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class);

async function fareRulesByClass() {
    const rules = await prisma.fareRule.findMany();
    return new Map(rules.map((rule) => [rule.class, rule]));
}

// --------------------------------------------------------------------------- search

export async function searchTrains({ from, to, date, quota }: SearchTrainsInput) {
    const stations = await prisma.station.findMany({
        where: { code: { in: [from, to] } },
        select: { id: true, code: true, name: true, city: true },
    });
    const fromStation = stations.find((s) => s.code === from);
    const toStation = stations.find((s) => s.code === to);
    if (!fromStation) throw new NotFoundError(`Station ${from}`);
    if (!toStation) throw new NotFoundError(`Station ${to}`);

    // Query 1: every stop at `from`, with the same train's stop at `to` (if it has one). The
    // RouteStop(stationId) index makes this a lookup, not a scan of every route.
    const boardingStops = await prisma.routeStop.findMany({
        where: { stationId: fromStation.id, departureMinutes: { not: null } },
        select: {
            departureMinutes: true,
            sequence: true,
            distanceKm: true,
            train: {
                select: {
                    id: true,
                    number: true,
                    name: true,
                    departureMinutes: true,
                    routeStops: {
                        where: { stationId: toStation.id },
                        select: { sequence: true, arrivalMinutes: true, distanceKm: true },
                    },
                },
            },
        },
    });

    // Keep trains that reach `to` *after* `from` (a train stopping at both in the other order goes
    // the wrong way). Then work out which schedule to look at: `date` is the boarding date, so a
    // train that reaches `from` on day 2 of its run left its origin the day before.
    const legs = boardingStops.flatMap((boarding) => {
        const alighting = boarding.train.routeStops[0];
        if (!alighting || alighting.sequence <= boarding.sequence) return [];
        // Checked again here (not just in the query) so TypeScript knows both are numbers below.
        if (boarding.departureMinutes === null || alighting.arrivalMinutes === null) return [];

        const dayOfRun = Math.floor((boarding.train.departureMinutes + boarding.departureMinutes) / MINUTES_PER_DAY);
        return [{
            train: boarding.train,
            departureMinutes: boarding.departureMinutes,
            arrivalMinutes: alighting.arrivalMinutes,
            distanceKm: alighting.distanceKm - boarding.distanceKm,
            journeyDate: addDays(date, -dayOfRun),
        }];
    });
    // The station ids were only needed for the query; responses identify stations by code.
    const station = ({ code, name, city }: typeof fromStation) => ({ code, name, city });
    const result = { from: station(fromStation), to: station(toStation), date: toIsoDate(date), quota };
    if (legs.length === 0) return { ...result, trains: [] };

    // Query 2: those trains' schedules on the computed dates, with this quota's inventory only.
    // Query 3 (in parallel): the fare table. Three queries in total, however many trains match.
    const [schedules, fareRules] = await Promise.all([
        prisma.trainSchedule.findMany({
            where: {
                status: { not: "CANCELLED" },
                OR: legs.map((leg) => ({ trainId: leg.train.id, journeyDate: leg.journeyDate })),
            },
            select: {
                id: true,
                trainId: true,
                status: true,
                inventories: { where: { quota } },
            },
        }),
        fareRulesByClass(),
    ]);
    const scheduleByTrain = new Map(schedules.map((s) => [s.trainId, s]));
    const today = todayUtc();

    const trains = legs.flatMap((leg) => {
        const schedule = scheduleByTrain.get(leg.train.id);
        if (!schedule) return []; // the train doesn't run on that date
        const bookable = isBookable(schedule.status, date, today);
        return [{
            scheduleId: schedule.id,
            number: leg.train.number,
            name: leg.train.name,
            departure: moment(leg.journeyDate, leg.train.departureMinutes, leg.departureMinutes),
            arrival: moment(leg.journeyDate, leg.train.departureMinutes, leg.arrivalMinutes),
            durationMinutes: leg.arrivalMinutes - leg.departureMinutes,
            distanceKm: leg.distanceKm,
            bookable,
            classes: schedule.inventories
                .map((inventory) => {
                    const rule = fareRules.get(inventory.class);
                    return {
                        class: inventory.class,
                        fare: rule ? fareFor(rule, leg.distanceKm, quota) : null,
                        availability: availabilityOf(inventory, bookable),
                    };
                })
                .sort(byClassOrder),
        }];
    });

    // Earliest departure first. Every result boards on `date`, so comparing "HH:mm" strings works.
    trains.sort((a, b) => a.departure.time.localeCompare(b.departure.time));
    return { ...result, trains };
}

// --------------------------------------------------------------------------- availability

interface StopWithStation {
    id: string;
    sequence: number;
    arrivalMinutes: number | null;
    departureMinutes: number | null;
    distanceKm: number;
    station: { code: string; name: string; city: string };
}

// Finds the boarding and alighting stops for a journey on one train (default: the whole route) and
// checks they make sense. Shared with booking, which must apply exactly the same rules.
export function resolveJourney(trainNumber: string, stops: StopWithStation[], from?: string, to?: string) {
    const findStop = (code: string) => {
        const stop = stops.find((s) => s.station.code === code);
        if (!stop) throw new BadRequestError("STATION_NOT_ON_ROUTE", `Train ${trainNumber} doesn't stop at ${code}`);
        return stop;
    };
    // Without `from` / `to`, use the whole route: origin to terminus.
    const boarding = from ? findStop(from) : stops[0];
    const alighting = to ? findStop(to) : stops[stops.length - 1];
    if (
        !boarding || !alighting || alighting.sequence <= boarding.sequence ||
        boarding.departureMinutes === null || alighting.arrivalMinutes === null
    ) {
        throw new BadRequestError("INVALID_JOURNEY", "`to` must be a stop after `from` on this train's route");
    }
    // Spread + explicit fields: returns the stops with TypeScript now knowing the times aren't null.
    return {
        boarding: { ...boarding, departureMinutes: boarding.departureMinutes },
        alighting: { ...alighting, arrivalMinutes: alighting.arrivalMinutes },
        distanceKm: alighting.distanceKm - boarding.distanceKm,
    };
}

const QUOTA_ORDER: Quota[] = ["GENERAL", "TATKAL", "LADIES", "SENIOR_CITIZEN"];

export async function getAvailability(scheduleId: string, query: AvailabilityQuery) {
    const [schedule, fareRules] = await Promise.all([
        prisma.trainSchedule.findUnique({
            where: { id: scheduleId },
            include: {
                inventories: true,
                train: {
                    select: {
                        number: true,
                        name: true,
                        departureMinutes: true,
                        routeStops: {
                            orderBy: { sequence: "asc" },
                            include: { station: { select: { code: true, name: true, city: true } } },
                        },
                    },
                },
            },
        }),
        fareRulesByClass(),
    ]);
    if (!schedule) throw new NotFoundError("Schedule");

    const { train } = schedule;
    const { boarding, alighting, distanceKm } = resolveJourney(train.number, train.routeStops, query.from, query.to);
    const departure = moment(schedule.journeyDate, train.departureMinutes, boarding.departureMinutes);
    const bookable = isBookable(schedule.status, new Date(`${departure.date}T00:00:00Z`), todayUtc());

    // Group the flat inventory rows (one per class + quota) into classes, each with its quotas.
    const classes = new Map<CoachClass, { quota: Quota; fare: number | null; availability: ReturnType<typeof availabilityOf> }[]>();
    for (const inventory of schedule.inventories) {
        const rule = fareRules.get(inventory.class);
        const quotas = classes.get(inventory.class) ?? [];
        quotas.push({
            quota: inventory.quota,
            fare: rule ? fareFor(rule, distanceKm, inventory.quota) : null,
            availability: availabilityOf(inventory, bookable),
        });
        classes.set(inventory.class, quotas);
    }

    return {
        scheduleId: schedule.id,
        train: { number: train.number, name: train.name },
        journeyDate: toIsoDate(schedule.journeyDate),
        status: schedule.status,
        bookable,
        from: { station: boarding.station, departure },
        to: { station: alighting.station, arrival: moment(schedule.journeyDate, train.departureMinutes, alighting.arrivalMinutes) },
        distanceKm,
        durationMinutes: alighting.arrivalMinutes - boarding.departureMinutes,
        classes: [...classes]
            .map(([coachClass, quotas]) => ({
                class: coachClass,
                quotas: quotas.sort((a, b) => QUOTA_ORDER.indexOf(a.quota) - QUOTA_ORDER.indexOf(b.quota)),
            }))
            .sort(byClassOrder),
    };
}
