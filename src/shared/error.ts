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

export class BadRequestError extends AppError {
    constructor(code: string, message: string) {
        super(400, code, message);
    }
}

// 401: "we don't know who you are" — missing, invalid or expired credentials.
export class UnauthorizedError extends AppError {
    constructor(message = "Authentication required") {
        super(401, "UNAUTHORIZED", message);
    }
}

// 403: "we know who you are, but you're not allowed to do this".
export class ForbiddenError extends AppError {
    constructor(message = "You do not have permission to perform this action", code = "FORBIDDEN") {
        super(403, code, message);
    }
}