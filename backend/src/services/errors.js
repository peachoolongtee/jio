// Thrown when an external API (OneMap, data.gov.sg or LTA) fails: a bad status,
// a timeout, an empty body, or a body that is not JSON.
//
// How to call:
//   throw new ExternalApiError('onemap answered 503', {
//     service: 'onemap',
//     status: 503,
//     url: 'https://www.onemap.gov.sg/api/public/routingsvc/route?...',
//   })
//
// How to catch it. Catch this class only, so real bugs still crash loudly:
//   try {
//     route = await http.getJson(url, { headers })
//   } catch (err) {
//     if (!(err instanceof ExternalApiError)) throw err
//     route = estimateFromDistance(origin, venue) // Then mark the result approximate.
//   }
export class ExternalApiError extends Error {
  constructor(message, { service, status = null, url } = {}) {
    super(message)
    this.name = 'ExternalApiError'
    // Which provider failed: 'onemap', 'datagov', 'lta' or 'unknown'.
    this.service = service
    // The HTTP status, or null when no response arrived (timeout, network down).
    this.status = status
    // The URL that was requested.
    this.url = url
  }
}
