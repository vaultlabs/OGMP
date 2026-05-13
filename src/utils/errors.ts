export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION", 422);
    this.name = "ValidationError";
  }
}

export class StateMachineError extends AppError {
  constructor(message: string) {
    super(message, "INVALID_STATE", 409);
    this.name = "StateMachineError";
  }
}
