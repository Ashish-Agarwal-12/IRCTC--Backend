// Environment for the test run. Tests use their own database (irctc_test) so they can wipe it
// freely without touching your development data. Everything is set here rather than read from
// .env, so the tests run the same on any machine (and in CI) as long as Postgres is up.

export const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgresql://irctc:irctc@localhost:5432/irctc_test";

export const testEnv = {
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-characters-long",
    APP_URL: "http://localhost:3000",
};
