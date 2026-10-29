// Shapes of every JSON response the API sends. They serve two purposes:
// 1. They're rendered into the OpenAPI document, so Swagger UI shows exactly what comes back.
// 2. The test suite parses every real response against them (see test/setup.ts). They use
//    z.strictObject, so a response with an extra, undocumented field fails the tests too:
//    the docs can't silently fall behind the code.
//
// These describe the JSON on the wire, so dates are ISO strings, not Date objects.

import "zod-openapi"; // adds OpenAPI fields (id, example, ...) to the type of Zod's .meta()
import { z } from "zod";
import { CoachClass, Role, Weekday } from "../generated/prisma/client.js";

export const errorResponse = z
    .strictObject({
        error: z.strictObject({
            code: z.string().meta({ example: "VALIDATION_ERROR" }),
            message: z.string(),
            details: z.unknown().optional().meta({ description: "Field-level problems (validation errors only)" }),
            requestId: z.string().optional().meta({ description: "Present on 500s: quote it when reporting a bug" }),
        }),
    })
    .meta({ id: "Error" });

export const messageResponse = z.strictObject({ message: z.string() }).meta({ id: "Message" });

export const healthResponse = z.strictObject({ status: z.literal("ok") });

export const adminPingResponse = z.strictObject({ status: z.literal("ok"), admin: z.literal(true) });

// --------------------------------------------------------------------------- auth

export const user = z
    .strictObject({
        id: z.string(),
        email: z.email(),
        phone: z.string().nullable(),
        firstName: z.string(),
        lastName: z.string(),
        role: z.enum(Role),
        isEmailVerified: z.boolean(),
        createdAt: z.iso.datetime(),
    })
    .meta({ id: "User" });

export const userResponse = z.strictObject({ user });

export const sessionResponse = z
    .strictObject({
        accessToken: z.string().meta({ description: "JWT. Send as `Authorization: Bearer <token>`. Valid for `expiresIn` seconds." }),
        refreshToken: z.string().meta({ description: "Single-use. Exchange at POST /auth/refresh for a new pair." }),
        expiresIn: z.number().int().meta({ example: 900 }),
    })
    .meta({ id: "Session" });

// --------------------------------------------------------------------------- stations

export const station = z
    .strictObject({
        id: z.string(),
        code: z.string().meta({ example: "NDLS" }),
        name: z.string().meta({ example: "New Delhi" }),
        city: z.string().meta({ example: "Delhi" }),
    })
    .meta({ id: "Station" });

export const stationResponse = z.strictObject({ station });
export const stationListResponse = z.strictObject({ stations: z.array(station) });

// --------------------------------------------------------------------------- trains

const trainSummaryShape = {
    id: z.string(),
    number: z.string().meta({ example: "12952" }),
    name: z.string().meta({ example: "Mumbai Rajdhani Express" }),
    runningDays: z.array(z.enum(Weekday)),
    departureTime: z.string().meta({ description: "Departure from the origin, HH:mm", example: "16:55" }),
};

export const trainSummary = z.strictObject(trainSummaryShape).meta({ id: "TrainSummary" });

const stopTime = z
    .strictObject({
        time: z.string().meta({ example: "08:50" }),
        day: z.number().int().meta({ description: "1 = the day the train leaves its origin", example: 2 }),
    })
    .nullable()
    .meta({ id: "StopTime" });

export const trainDetails = z
    .strictObject({
        ...trainSummaryShape,
        route: z.array(
            z.strictObject({
                sequence: z.number().int(),
                station: z.strictObject({ code: z.string(), name: z.string(), city: z.string() }),
                arrival: stopTime.meta({ description: "null at the origin" }),
                departure: stopTime.meta({ description: "null at the terminus" }),
                distanceKm: z.number().int(),
            }),
        ),
        coaches: z.array(z.strictObject({ code: z.string(), class: z.enum(CoachClass), seats: z.number().int() })),
    })
    .meta({ id: "TrainDetails" });

export const trainResponse = z.strictObject({ train: trainDetails });

export const trainListResponse = z
    .strictObject({
        items: z.array(trainSummary),
        page: z.number().int(),
        pageSize: z.number().int(),
        total: z.number().int(),
    })
    .meta({ id: "TrainList" });

export const scheduleResultResponse = z
    .strictObject({
        runningDates: z.number().int().meta({ description: "Dates in the range the train runs on" }),
        created: z.number().int().meta({ description: "Schedules created by this call" }),
        skipped: z.number().int().meta({ description: "Dates that already had a schedule" }),
    })
    .meta({ id: "ScheduleGenerationResult" });
