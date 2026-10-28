/** Safe public errors. Internal details never reach the client. */
export class PublicError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const errors = {
  unsupportedImage: () =>
    new PublicError("unsupported_image", 400, "The uploaded file is not a supported image."),
  imageTooLarge: () =>
    new PublicError("image_too_large", 413, "The uploaded image is too large."),
  requestTooLarge: () =>
    new PublicError("request_too_large", 413, "The request is too large."),
  invalidRequest: () =>
    new PublicError("invalid_request", 400, "The request could not be understood."),
  invalidCurrency: () =>
    new PublicError("invalid_currency", 400, "The bucket currency is not a valid ISO 4217 code."),
  extractionUnavailable: () =>
    new PublicError("extraction_unavailable", 502, "Extraction is unavailable right now."),
  liveDisabled: () =>
    new PublicError("live_disabled", 403, "Live Meta testing is not enabled on this server."),
  liveUnauthorized: () =>
    new PublicError("live_unauthorized", 403, "Live Meta testing was not authorized for this request."),
  liveLimitReached: () =>
    new PublicError("live_limit_reached", 429, "The live test request limit for this server session has been reached."),
  metaUnavailable: () =>
    new PublicError("meta_unavailable", 502, "The Meta Model API could not be reached or returned an unusable response."),
  notFound: () => new PublicError("not_found", 404, "Not found."),
};
