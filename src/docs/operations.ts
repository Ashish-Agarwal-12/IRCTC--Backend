// The API's single list of endpoints. Each entry reuses the Zod schemas the controllers already
// validate with, so the documented request shape *is* the enforced one. openapi.ts turns this list
// into an OpenAPI document, and the test suite uses it to check every real response.
//
// Adding an endpoint? Add it here too: test/openapi.test.ts fails if a route is missing.

import "zod-openapi";
import { z } from "zod";
import {
    emailOnlySchema, loginSchema, refreshSchema, registerSchema, resetPasswordSchema, tokenSchema,
} from "../modules/auth/auth.schemas.js";
import { createStationSchema, searchStationsSchema, updateStationSchema } from "../modules/stations/stations.schemas.js";
import {
    availabilityQuerySchema, createTrainSchema, generateSchedulesSchema, replaceCoachesSchema, replaceRouteSchema,
    scheduleIdParamSchema, searchTrainsSchema, trainNumberParamSchema,
} from "../modules/trains/trains.schemas.js";
import { createBookingSchema, idempotencyHeaderSchema, pnrParamSchema } from "../modules/bookings/bookings.schemas.js";
import { idParamSchema, paginationSchema } from "../shared/validation.js";
import * as R from "./responses.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface Operation {
    method: HttpMethod;
    path: string; // OpenAPI style: /admin/stations/{id}
    tag: string;
    summary: string;
    description?: string;
    auth?: "user" | "admin"; // adds the bearer-token requirement and the 401 (and 403) responses
    rateLimited?: boolean; // adds the 429 response
    body?: z.ZodType;
    query?: z.ZodObject;
    params?: z.ZodObject;
    headers?: z.ZodObject;
    // Success responses (and endpoint-specific errors). Standard errors are added automatically.
    responses: Record<number, { description: string; schema?: z.ZodType; html?: boolean }>;
}

const error = (description: string) => ({ description, schema: R.errorResponse });

export const operations: Operation[] = [
    // ------------------------------------------------------------------- system
    {
        method: "get", path: "/health", tag: "System", summary: "Health check",
        responses: { 200: { description: "The server is up", schema: R.healthResponse } },
    },

    // ------------------------------------------------------------------- auth
    {
        method: "post", path: "/auth/register", tag: "Auth", summary: "Create an account",
        description: "Sends a verification email (in development, view it in Mailpit at http://localhost:8025).",
        rateLimited: true,
        body: registerSchema.meta({
            id: "RegisterRequest",
            example: { email: "asha@example.test", password: "password123", firstName: "Asha", lastName: "K", phone: "9876543210" },
        }),
        responses: {
            201: { description: "Account created (unverified)", schema: R.userResponse },
            409: error("Email or phone already registered"),
        },
    },
    {
        method: "post", path: "/auth/verify-email", tag: "Auth", summary: "Verify an email address",
        description: "The token comes from the link in the verification email (`#token=...`). Single-use.",
        rateLimited: true,
        body: tokenSchema.meta({ id: "TokenRequest" }),
        responses: { 204: { description: "Email verified" } },
    },
    {
        method: "post", path: "/auth/resend-verification", tag: "Auth", summary: "Resend the verification email",
        description: "Always answers 202, whether or not the account exists, so it can't be used to discover accounts.",
        rateLimited: true,
        body: emailOnlySchema.meta({ id: "EmailRequest", example: { email: "asha@example.test" } }),
        responses: { 202: { description: "Accepted", schema: R.messageResponse } },
    },
    {
        method: "post", path: "/auth/login", tag: "Auth", summary: "Log in",
        description: "Copy `accessToken` from the response into **Authorize** (top right) to call protected endpoints.",
        rateLimited: true,
        body: loginSchema.meta({ id: "LoginRequest", example: { email: "asha@example.test", password: "password123" } }),
        responses: {
            200: { description: "Logged in", schema: R.sessionResponse },
            401: error("Wrong email or password (same answer for both)"),
            403: error("Email not verified yet (`EMAIL_NOT_VERIFIED`)"),
        },
    },
    {
        method: "post", path: "/auth/refresh", tag: "Auth", summary: "Exchange a refresh token for a new pair",
        description: "Refresh tokens are single-use. Presenting one that was already used revokes that whole session.",
        rateLimited: true,
        body: refreshSchema.meta({ id: "RefreshRequest" }),
        responses: {
            200: { description: "New token pair", schema: R.sessionResponse },
            401: error("Unknown, expired, revoked or reused refresh token"),
        },
    },
    {
        method: "post", path: "/auth/logout", tag: "Auth", summary: "Log out (revoke a refresh token)",
        rateLimited: true,
        body: refreshSchema,
        responses: { 204: { description: "Logged out (also when the token was already invalid)" } },
    },
    {
        method: "post", path: "/auth/forgot-password", tag: "Auth", summary: "Request a password-reset email",
        description: "Always answers 202, whether or not the account exists.",
        rateLimited: true,
        body: emailOnlySchema,
        responses: { 202: { description: "Accepted", schema: R.messageResponse } },
    },
    {
        method: "post", path: "/auth/reset-password", tag: "Auth", summary: "Set a new password using a reset token",
        description: "Also logs out every existing session of that user.",
        rateLimited: true,
        body: resetPasswordSchema.meta({ id: "ResetPasswordRequest" }),
        responses: { 204: { description: "Password changed" } },
    },
    {
        method: "get", path: "/auth/me", tag: "Auth", summary: "The logged-in user", auth: "user",
        responses: { 200: { description: "Current user", schema: R.userResponse }, 404: error("User no longer exists") },
    },

    // ------------------------------------------------------------------- email-link pages
    {
        method: "get", path: "/verify-email", tag: "Email-link pages", summary: "Page opened by the verification email link",
        description: "HTML page. Reads the token from the URL fragment and POSTs it to /auth/verify-email when the user clicks.",
        responses: { 200: { description: "HTML page", html: true } },
    },
    {
        method: "get", path: "/reset-password", tag: "Email-link pages", summary: "Page opened by the password-reset email link",
        description: "HTML page with a new-password form that POSTs to /auth/reset-password.",
        responses: { 200: { description: "HTML page", html: true } },
    },

    // ------------------------------------------------------------------- catalog (public)
    {
        method: "get", path: "/stations", tag: "Stations", summary: "Search stations (autocomplete)",
        description: "Matches the start of the code, or any part of the name or city. At most 10 results, exact code match first.",
        query: searchStationsSchema,
        responses: { 200: { description: "Matching stations", schema: R.stationListResponse } },
    },
    {
        method: "get", path: "/trains", tag: "Trains", summary: "List trains",
        query: paginationSchema,
        responses: { 200: { description: "One page of trains", schema: R.trainListResponse } },
    },
    {
        method: "get", path: "/trains/search", tag: "Trains", summary: "Search trains between two stations on a date",
        description:
            "`date` is the day you board at `from`. Lists trains that stop at `from` and later at `to` and run that day, " +
            "earliest departure first, with the fare and availability of each class in `quota` (default GENERAL). " +
            "Availability is a snapshot: booking re-checks it.",
        query: searchTrainsSchema.meta({ example: { from: "NDLS", to: "MMCT", date: "2026-11-01" } }),
        responses: {
            200: { description: "Matching trains (empty list if none run that day)", schema: R.trainSearchResponse },
            404: error("Unknown station code"),
        },
    },
    {
        method: "get", path: "/trains/{number}", tag: "Trains", summary: "A train with its route and coaches",
        params: trainNumberParamSchema,
        responses: { 200: { description: "Train details", schema: R.trainResponse }, 404: error("No such train") },
    },

    {
        method: "get", path: "/trains/{scheduleId}/availability", tag: "Trains", summary: "Availability and fares of one schedule, per class and quota",
        description:
            "Get `scheduleId` from search. `from` / `to` choose the part of the route you travel (default: the whole route); " +
            "they change the fare and times, not the counts (inventory is per journey).",
        params: scheduleIdParamSchema,
        query: availabilityQuerySchema,
        responses: {
            200: { description: "Availability", schema: R.availabilityResponse },
            400: error("Invalid input, a station not on the route (`STATION_NOT_ON_ROUTE`) or `to` not after `from` (`INVALID_JOURNEY`)"),
            404: error("No such schedule"),
        },
    },

    // ------------------------------------------------------------------- bookings
    {
        method: "post", path: "/bookings", tag: "Bookings", summary: "Hold seats (10 minutes) for up to 6 passengers", auth: "user", rateLimited: true,
        description:
            "Allots each passenger in order: a confirmed berth while any are left, then RAC, then a waitlist number, so one " +
            "booking can be split (e.g. 2 CONFIRMED + 1 RAC). Refused (409 `REGRET`) if not everyone fits. The booking is " +
            "`PENDING_PAYMENT` until `holdExpiresAt`; unpaid holds then become `EXPIRED` and their seats are released. " +
            "Needs a verified email. Retrying with the same `Idempotency-Key` returns the original booking (200) instead of booking again.",
        headers: idempotencyHeaderSchema,
        body: createBookingSchema.meta({
            id: "CreateBookingRequest",
            example: {
                scheduleId: "paste a scheduleId from GET /trains/search",
                from: "NDLS", to: "MMCT", class: "AC3", quota: "GENERAL",
                passengers: [
                    { name: "Asha Kumar", age: 34, gender: "FEMALE", berthPreference: "LOWER" },
                    { name: "Ravi Kumar", age: 36, gender: "MALE" },
                ],
                contactPhone: "9876543210",
            },
        }),
        responses: {
            201: { description: "Seats held", schema: R.bookingResponse },
            200: { description: "Same Idempotency-Key as an earlier request: that booking, unchanged", schema: R.bookingResponse },
            400: error("Invalid input, quota eligibility, `STATION_NOT_ON_ROUTE`, `INVALID_JOURNEY`, `QUOTA_NOT_AVAILABLE` or `CONTACT_PHONE_REQUIRED`"),
            403: error("Email not verified (`EMAIL_NOT_VERIFIED`)"),
            404: error("No such schedule"),
            409: error("`REGRET` (no berths, RAC or waitlist left), `BOOKING_CLOSED` or `FARE_NOT_SET`"),
        },
    },
    {
        method: "get", path: "/bookings", tag: "Bookings", summary: "Your bookings, newest first", auth: "user",
        query: paginationSchema,
        responses: { 200: { description: "One page of bookings", schema: R.bookingListResponse } },
    },
    {
        method: "get", path: "/bookings/{pnr}", tag: "Bookings", summary: "One of your bookings by PNR (PNR status)", auth: "user",
        params: pnrParamSchema,
        responses: { 200: { description: "The booking", schema: R.bookingResponse }, 404: error("No such booking among yours") },
    },

    // ------------------------------------------------------------------- admin
    {
        method: "get", path: "/admin/ping", tag: "Admin", summary: "Check admin access", auth: "admin",
        responses: { 200: { description: "You are an admin", schema: R.adminPingResponse } },
    },
    {
        method: "post", path: "/admin/stations", tag: "Admin: stations", summary: "Create a station", auth: "admin",
        body: createStationSchema.meta({ id: "CreateStationRequest", example: { code: "PUNE", name: "Pune Junction", city: "Pune" } }),
        responses: {
            201: { description: "Created", schema: R.stationResponse },
            409: error("Station code already exists"),
        },
    },
    {
        method: "patch", path: "/admin/stations/{id}", tag: "Admin: stations", summary: "Update a station's name or city", auth: "admin",
        params: idParamSchema,
        body: updateStationSchema.meta({ id: "UpdateStationRequest", example: { name: "Pune Junction" } }),
        responses: { 200: { description: "Updated", schema: R.stationResponse }, 404: error("No such station") },
    },
    {
        method: "post", path: "/admin/trains", tag: "Admin: trains", summary: "Create a train", auth: "admin",
        description: "Then set its route and coaches, then generate schedules.",
        body: createTrainSchema.meta({
            id: "CreateTrainRequest",
            example: { number: "12951", name: "Mumbai Rajdhani Express", runningDays: ["MON", "WED", "FRI"], departureTime: "17:00" },
        }),
        responses: {
            201: { description: "Created", schema: R.trainResponse },
            409: error("Train number already exists"),
        },
    },
    {
        method: "put", path: "/admin/trains/{id}/route", tag: "Admin: trains", summary: "Replace a train's whole route", auth: "admin",
        description:
            "Stops in order; array position = sequence. Times are minutes after the origin departure. " +
            "The origin has `arrivalMinutes: null, departureMinutes: 0, distanceKm: 0`; the terminus has `departureMinutes: null`. " +
            "Times and distances must increase. Refused (409) once the train has bookings.",
        params: idParamSchema,
        body: replaceRouteSchema.meta({
            id: "ReplaceRouteRequest",
            example: {
                stops: [
                    { stationCode: "MMCT", arrivalMinutes: null, departureMinutes: 0, distanceKm: 0 },
                    { stationCode: "KOTA", arrivalMinutes: 680, departureMinutes: 685, distanceKm: 921 },
                    { stationCode: "NDLS", arrivalMinutes: 955, departureMinutes: null, distanceKm: 1386 },
                ],
            },
        }),
        responses: {
            200: { description: "Updated train", schema: R.trainResponse },
            404: error("No such train"),
            409: error("Train has bookings"),
        },
    },
    {
        method: "put", path: "/admin/trains/{id}/coaches", tag: "Admin: trains", summary: "Replace a train's coaches", auth: "admin",
        description: "Seats are generated from standard layouts (SL/3A 72, 2A 48, 1A 24, CC 78). Refused (409) once schedules exist.",
        params: idParamSchema,
        body: replaceCoachesSchema.meta({
            id: "ReplaceCoachesRequest",
            example: { coaches: [{ code: "A1", class: "AC2" }, { code: "B1", class: "AC3" }, { code: "B2", class: "AC3" }] },
        }),
        responses: {
            200: { description: "Updated train", schema: R.trainResponse },
            404: error("No such train"),
            409: error("Train already has schedules"),
        },
    },
    {
        method: "post", path: "/admin/trains/{id}/schedules", tag: "Admin: trains", summary: "Generate schedules and seat inventory", auth: "admin",
        description: "Creates one schedule per running day in [from, to] (max 120 days, not in the past). Safe to repeat: existing dates are skipped.",
        params: idParamSchema,
        body: generateSchedulesSchema.meta({ id: "GenerateSchedulesRequest", example: { from: "2026-11-01", to: "2026-11-30" } }),
        responses: {
            201: { description: "Result", schema: R.scheduleResultResponse },
            404: error("No such train"),
            409: error("Route or coaches not set yet"),
        },
    },
];

// Every operation can also fail in standard ways; add those responses so each one is documented.
export function responsesFor(op: Operation): Operation["responses"] {
    const all = { ...op.responses };
    const add = (status: number, description: string) => { all[status] ??= error(description); };
    if (op.body || op.query || op.params) add(400, "Invalid input (`VALIDATION_ERROR`, with `details` per field)");
    if (op.auth) add(401, "Missing, invalid or expired access token");
    if (op.auth === "admin") add(403, "Logged in, but not an admin");
    if (op.rateLimited) add(429, "Too many requests (`RATE_LIMITED`); see the `Retry-After` header");
    add(500, "Unexpected server error (includes `requestId`)");
    return all;
}
