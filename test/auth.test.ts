import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the real mailer with a fake *before* the app is imported, so no SMTP server is needed
// and tests can read the token straight out of the "sent" email. vi.mock is hoisted to the top.
vi.mock("../src/shared/mailer.js", () => ({ sendMail: vi.fn(async () => {}) }));

import { sendMail } from "../src/shared/mailer.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";

const mockedSendMail = vi.mocked(sendMail);

// Pull the token out of the most recent email's link (…#token=XYZ).
function tokenFromLastEmail(): string {
    const text = mockedSendMail.mock.calls.at(-1)?.[2] ?? "";
    const match = /token=([\w-]+)/.exec(text);
    if (!match) throw new Error("No token in last email");
    return match[1];
}

const newUser = { email: "asha@example.test", password: "password123", firstName: "Asha", lastName: "K" };

// Registers, verifies and logs in; returns the session. Used by the tests that start "logged in".
async function registerAndLogin() {
    await api().post("/auth/register").send(newUser).expect(201);
    await api().post("/auth/verify-email").send({ token: tokenFromLastEmail() }).expect(204);
    const res = await api().post("/auth/login").send({ email: newUser.email, password: newUser.password }).expect(200);
    return res.body as { accessToken: string; refreshToken: string };
}

beforeEach(async () => {
    await resetDb();
    mockedSendMail.mockClear();
});

describe("registration and email verification", () => {
    it("registers, normalises the email, and sends a verification link", async () => {
        const res = await api().post("/auth/register").send({ ...newUser, email: "  ASHA@Example.TEST " });

        expect(res.status).toBe(201);
        expect(res.body.user).toMatchObject({ email: "asha@example.test", isEmailVerified: false });
        expect(res.body.user).not.toHaveProperty("passwordHash");
        expect(mockedSendMail).toHaveBeenCalledOnce();
        expect(mockedSendMail.mock.calls[0][2]).toContain("/verify-email#token=");
    });

    it("rejects a duplicate email with 409", async () => {
        await api().post("/auth/register").send(newUser).expect(201);
        const res = await api().post("/auth/register").send(newUser);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("CONFLICT");
    });

    it("rejects invalid input with 400 and field details", async () => {
        const res = await api().post("/auth/register").send({ email: "nope", password: "short" });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        const fields = res.body.error.details.map((d: { path: string[] }) => d.path[0]);
        expect(fields).toEqual(expect.arrayContaining(["email", "password", "firstName"]));
    });

    it("blocks login until the email is verified, and links are single-use", async () => {
        await api().post("/auth/register").send(newUser).expect(201);
        const login = () => api().post("/auth/login").send({ email: newUser.email, password: newUser.password });

        expect((await login()).body.error.code).toBe("EMAIL_NOT_VERIFIED");

        const token = tokenFromLastEmail();
        await api().post("/auth/verify-email").send({ token }).expect(204);
        await api().post("/auth/verify-email").send({ token }).expect(400);
        await login().expect(200);
    });
});

describe("login and access tokens", () => {
    it("gives the same 401 for a wrong password and an unknown email", async () => {
        await registerAndLogin();
        const wrongPassword = await api().post("/auth/login").send({ email: newUser.email, password: "wrong-password" });
        const unknownEmail = await api().post("/auth/login").send({ email: "ghost@example.test", password: "whatever1" });

        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(wrongPassword.body).toEqual(unknownEmail.body);
    });

    it("protects /auth/me", async () => {
        const { accessToken } = await registerAndLogin();
        await api().get("/auth/me").expect(401);
        await api().get("/auth/me").set(bearer(accessToken + "x")).expect(401);
        const res = await api().get("/auth/me").set(bearer(accessToken)).expect(200);
        expect(res.body.user.email).toBe(newUser.email);
    });

    it("enforces roles on admin routes", async () => {
        const user = await createUser();
        const admin = await createUser({ role: "ADMIN" });
        await api().get("/admin/ping").set(bearer(user.token)).expect(403);
        await api().get("/admin/ping").set(bearer(admin.token)).expect(200);
    });
});

describe("refresh token rotation", () => {
    it("rotates on refresh and kills the session when an old token is reused", async () => {
        const { refreshToken: first } = await registerAndLogin();

        const rotated = await api().post("/auth/refresh").send({ refreshToken: first }).expect(200);
        const second = rotated.body.refreshToken;
        expect(second).not.toBe(first);

        // Replaying the first token looks like theft: both it and its successor stop working.
        await api().post("/auth/refresh").send({ refreshToken: first }).expect(401);
        await api().post("/auth/refresh").send({ refreshToken: second }).expect(401);
    });

    it("lets exactly one of several simultaneous refreshes succeed", async () => {
        const { refreshToken } = await registerAndLogin();

        const results = await Promise.all(
            Array.from({ length: 5 }, () => api().post("/auth/refresh").send({ refreshToken })),
        );
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, 401, 401, 401, 401]);
    });

    it("logout revokes the refresh token", async () => {
        const { refreshToken } = await registerAndLogin();
        await api().post("/auth/logout").send({ refreshToken }).expect(204);
        await api().post("/auth/refresh").send({ refreshToken }).expect(401);
    });
});

describe("password reset", () => {
    it("always answers 202, resets the password, and revokes existing sessions", async () => {
        const { refreshToken } = await registerAndLogin();

        await api().post("/auth/forgot-password").send({ email: "ghost@example.test" }).expect(202);
        await api().post("/auth/forgot-password").send({ email: newUser.email }).expect(202);
        expect(mockedSendMail.mock.calls.at(-1)?.[2]).toContain("/reset-password#token=");

        await api().post("/auth/reset-password")
            .send({ token: tokenFromLastEmail(), password: "a-new-password" })
            .expect(204);

        await api().post("/auth/refresh").send({ refreshToken }).expect(401);
        await api().post("/auth/login").send({ email: newUser.email, password: newUser.password }).expect(401);
        await api().post("/auth/login").send({ email: newUser.email, password: "a-new-password" }).expect(200);
    });
});
