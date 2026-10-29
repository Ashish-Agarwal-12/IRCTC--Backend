export class AppError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
    }
}

export class NotFoundError extends AppError {
    constructor(what: string) {
        super(404, "NOT_FOUND", `${what} not found`);
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super(409, "CONFLICT", message);
    }
}