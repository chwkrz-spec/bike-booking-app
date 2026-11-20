export class OperationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
