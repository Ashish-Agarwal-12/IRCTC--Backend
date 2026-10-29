// Shapes of every JSON response the API sends. They serve two purposes:
// 1. They're rendered into the OpenAPI document, so Swagger UI shows exactly what comes back.
// 2. The test suite parses every real response against them (see test/setup.ts). They use
//    z.strictObject, so a response with an extra, undocumented field fails the tests too:
//    the docs can't silently fall behind the code.
//
// These describe the JSON on the wire, so dates are ISO strings, not Date objects.

import "zod-openapi"; // adds OpenAPI fields (id, example, ...) to the type of Zod's .meta()
import { z } from "zod";
import {
    BerthType, BookingStatus, CoachClass, Gender, PassengerStatus, Quota, Role, ScheduleStatus, Weekday,
} from "../generated/prisma/client.js";
import { AVAILABILITY_STATUSES } from "../modules/trains/availability.js";

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

// --------------------------------------------------------------------------- search & availability

const stationRef = z.strictObject({ code: z.string(), name: z.string(), city: z.string() }).meta({ id: "StationRef" });

const journeyMoment = z
    .strictObject({ date: z.iso.date(), time: z.string().meta({ example: "21:30" }) })
    .meta({ id: "JourneyMoment", description: "Local date and time at the station" });

const fare = z.number().int().nullable().meta({
    description: "Per passenger, in paise (170400 = ₹1,704). null if no fare is set for the class.",
    example: 170400,
});

const availability = z
    .strictObject({
        status: z.enum(AVAILABILITY_STATUSES),
        count: z.number().int().nullable().meta({
            description: "AVAILABLE: berths left. RAC / WAITLIST: the number the next passenger would get. Otherwise null.",
        }),
        label: z.string().meta({ example: "AVL 42" }),
    })
    .meta({ id: "Availability" });

export const trainSearchResponse = z
    .strictObject({
        from: stationRef,
        to: stationRef,
        date: z.iso.date(),
        quota: z.enum(Quota),
        trains: z.array(
            z.strictObject({
                scheduleId: z.string().meta({ description: "Use with GET /trains/{scheduleId}/availability, and later to book" }),
                number: z.string(),
                name: z.string(),
                departure: journeyMoment,
                arrival: journeyMoment,
                durationMinutes: z.number().int(),
                distanceKm: z.number().int(),
                bookable: z.boolean(),
                classes: z.array(z.strictObject({ class: z.enum(CoachClass), fare, availability })),
            }),
        ),
    })
    .meta({ id: "TrainSearchResult" });

export const availabilityResponse = z
    .strictObject({
        scheduleId: z.string(),
        train: z.strictObject({ number: z.string(), name: z.string() }),
        journeyDate: z.iso.date().meta({ description: "The day the train leaves its origin" }),
        status: z.enum(ScheduleStatus),
        bookable: z.boolean(),
        from: z.strictObject({ station: stationRef, departure: journeyMoment }),
        to: z.strictObject({ station: stationRef, arrival: journeyMoment }),
        distanceKm: z.number().int(),
        durationMinutes: z.number().int(),
        classes: z.array(
            z.strictObject({
                class: z.enum(CoachClass),
                quotas: z.array(z.strictObject({ quota: z.enum(Quota), fare, availability })),
            }),
        ),
    })
    .meta({ id: "ScheduleAvailability" });

// --------------------------------------------------------------------------- bookings

export const booking = z
    .strictObject({
        pnr: z.string().meta({ example: "4821093756" }),
        status: z.enum(BookingStatus),
        holdExpiresAt: z.iso.datetime().nullable().meta({ description: "Pay before this. Set only while PENDING_PAYMENT." }),
        train: z.strictObject({ number: z.string(), name: z.string() }),
        journeyDate: z.iso.date().meta({ description: "The day the train leaves its origin" }),
        from: z.strictObject({ station: stationRef, departure: journeyMoment }),
        to: z.strictObject({ station: stationRef, arrival: journeyMoment }),
        class: z.enum(CoachClass),
        quota: z.enum(Quota),
        totalFare: z.number().int().meta({ description: "All passengers, in paise", example: 340800 }),
        passengers: z.array(
            z.strictObject({
                position: z.number().int(),
                name: z.string(),
                age: z.number().int(),
                gender: z.enum(Gender),
                berthPreference: z.enum(BerthType).nullable(),
                status: z.enum(PassengerStatus),
                racNumber: z.number().int().nullable(),
                waitlistNumber: z.number().int().nullable(),
                berth: z
                    .strictObject({ coach: z.string().meta({ example: "B1" }), number: z.number().int(), type: z.enum(BerthType) })
                    .nullable()
                    .meta({ description: "Set for CONFIRMED passengers; RAC and waitlisted passengers get one later" }),
            }),
        ),
        createdAt: z.iso.datetime(),
    })
    .meta({ id: "Booking" });

export const bookingResponse = z.strictObject({ booking });

export const bookingListResponse = z
    .strictObject({ items: z.array(booking), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() })
    .meta({ id: "BookingList" });

