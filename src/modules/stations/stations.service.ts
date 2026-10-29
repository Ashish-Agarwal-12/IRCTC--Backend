import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../shared/prisma.js";
import { ConflictError, NotFoundError } from "../../shared/error.js";
import type { CreateStationInput, UpdateStationInput } from "./stations.schemas.js";

const SEARCH_LIMIT = 10;

const publicFields = { id: true, code: true, name: true, city: true } satisfies Prisma.StationSelect;

// Autocomplete for the "From" / "To" boxes: "del" should find "New Delhi" (name), "Delhi" (city)
// and anything whose code starts with "DEL". Exact code matches go first, so typing "NDLS" puts
// New Delhi at the top.
// Fine at a few thousand stations; at scale this would use a Postgres trigram index (pg_trgm).
export async function searchStations(q: string) {
    const code = q.toUpperCase();
    const matches = await prisma.station.findMany({
        where: {
            OR: [
                { code: { startsWith: code } },
                { name: { contains: q, mode: "insensitive" } },
                { city: { contains: q, mode: "insensitive" } },
            ],
        },
        select: publicFields,
        orderBy: { name: "asc" },
        take: SEARCH_LIMIT,
    });
    // Stable sort: exact code match first, everything else keeps its alphabetical order.
    return matches.sort((a, b) => Number(b.code === code) - Number(a.code === code));
}

export async function createStation(input: CreateStationInput) {
    try {
        return await prisma.station.create({ data: input, select: publicFields });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new ConflictError(`Station ${input.code} already exists`);
        }
        throw err;
    }
}

export async function updateStation(id: string, input: UpdateStationInput) {
    try {
        return await prisma.station.update({ where: { id }, data: input, select: publicFields });
    } catch (err) {
        // P2025 = "the record you tried to update doesn't exist".
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
            throw new NotFoundError("Station");
        }
        throw err;
    }
}
