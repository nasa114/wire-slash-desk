export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class DuplicateFeedUrlError extends Error {
  constructor(feedUrl: string) {
    super(`feed_url already exists: ${feedUrl}`);
    this.name = 'DuplicateFeedUrlError';
  }
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`username already exists: ${username}`);
    this.name = 'DuplicateUsernameError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
