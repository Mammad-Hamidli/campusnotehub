import { providerConfig } from '@/lib/auth/oauth/providers';
import {
  findCalendarLink,
  markCalendarLinkRevoked,
  openRefreshToken,
} from '@/lib/firebase/repositories/calendarLinks';

/**
 * Google Calendar over plain REST: token refresh and revocation, and the
 * three event calls Meet provisioning needs. No `googleapis` dependency - it
 * is tens of megabytes for four HTTPS requests, and the lockfile here is
 * fragile enough already.
 *
 * Every call has a timeout, and no response body is ever logged: token
 * endpoint bodies can echo credentials.
 */

/** Create/read/delete events on calendars the mentor can edit - nothing else. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TIMEOUT_MS = 10_000;

/** The connection cannot be used; only the mentor reconnecting fixes it. */
export class CalendarAuthError extends Error {
  constructor(readonly reason: 'not_connected' | 'revoked' | 'scope' | 'not_configured') {
    super(`calendar auth: ${reason}`);
  }
}

/** A Calendar API failure. `transient` ones are worth retrying later. */
export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    readonly transient: boolean,
    detail: string,
  ) {
    super(`calendar api ${status}: ${detail}`);
  }
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const config = providerConfig('google');
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!config || !clientSecret) throw new CalendarAuthError('not_configured');
  return { clientId: config.clientId, clientSecret };
}

/**
 * Access tokens, per server instance, for their lifetime minus a minute.
 * Memory only: a token that is never written anywhere cannot leak from a
 * database dump, and losing the cache costs one refresh call.
 */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function forgetAccessToken(userId: string): void {
  accessTokens.delete(userId);
}

/** A usable access token for the mentor's calendar, refreshing if needed. */
export async function calendarAccessToken(userId: string): Promise<string> {
  const cached = accessTokens.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const link = await findCalendarLink(userId);
  if (!link) throw new CalendarAuthError('not_connected');
  if (link.status !== 'ACTIVE') throw new CalendarAuthError('revoked');
  if (!link.scope.split(' ').includes(CALENDAR_SCOPE)) throw new CalendarAuthError('scope');

  const { clientId, clientSecret } = clientCredentials();
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: openRefreshToken(link),
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new CalendarApiError(0, true, 'token endpoint unreachable');
  }

  const json = (await response.json().catch(() => null)) as
    | { access_token?: unknown; expires_in?: unknown; error?: unknown }
    | null;

  if (!response.ok) {
    /**
     * invalid_grant: the mentor revoked access in their Google account, the
     * grant expired (apps still in "Testing" get 7-day refresh tokens), or
     * the password changed. Nothing but a reconnect helps, so the link is
     * marked and the caller tells the mentor.
     */
    if (json?.error === 'invalid_grant') {
      await markCalendarLinkRevoked(userId);
      throw new CalendarAuthError('revoked');
    }
    throw new CalendarApiError(response.status, response.status >= 500 || response.status === 429, `token ${String(json?.error ?? '')}`);
  }
  if (typeof json?.access_token !== 'string') throw new CalendarApiError(502, true, 'token response without access_token');

  const lifetimeS = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  accessTokens.set(userId, { token: json.access_token, expiresAt: Date.now() + (lifetimeS - 60) * 1000 });
  return json.access_token;
}

/** Best-effort: a token Google no longer knows is already as revoked as it gets. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    console.warn('[calendar] token revocation did not reach Google');
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CalendarEvent = {
  id: string;
  status?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

export type MeetEventInput = {
  eventId: string;
  requestId: string;
  summary: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  bookingId: string;
};

async function calendarFetch(
  userId: string,
  token: string,
  url: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new CalendarApiError(0, true, 'calendar unreachable');
  }
  // A token revoked mid-hour: drop the cached one so the next try refreshes
  // (and discovers invalid_grant, if that is what happened).
  if (response.status === 401) forgetAccessToken(userId);
  return response;
}

async function failure(response: Response, what: string): Promise<CalendarApiError> {
  const json = (await response.json().catch(() => null)) as
    | { error?: { errors?: { reason?: string }[] } }
    | null;
  const reason = json?.error?.errors?.[0]?.reason ?? '';
  if (response.status === 403 && reason === 'insufficientPermissions') throw new CalendarAuthError('scope');
  const transient =
    response.status === 0 ||
    response.status === 401 ||
    response.status === 429 ||
    response.status >= 500 ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded';
  return new CalendarApiError(response.status, transient, `${what} ${reason}`.trim());
}

/**
 * Creates the session's event with a Meet room on the mentor's primary
 * calendar. Idempotent by design:
 *
 *  - the event id is derived from the booking, so a retry gets 409 and the
 *    existing event is read back instead of a second one being made;
 *  - conferenceData.createRequest.requestId is derived too, so Google never
 *    mints a second room for the same request.
 *
 * NO ATTENDEES, and sendUpdates=none. An attendee would receive the raw Meet
 * link in a Google invitation the moment the session is accepted, which
 * defeats handing it out only from 30 minutes before (see the join route).
 * The mentee joins through the platform and knocks; the mentor, as host,
 * admits them.
 */
export async function upsertMeetEvent(userId: string, input: MeetEventInput): Promise<CalendarEvent> {
  const token = await calendarAccessToken(userId);
  const response = await calendarFetch(userId, token, `${EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`, {
    method: 'POST',
    body: {
      id: input.eventId,
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startsAt.toISOString(), timeZone: input.timeZone },
      end: { dateTime: input.endsAt.toISOString(), timeZone: input.timeZone },
      visibility: 'private',
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: true },
      extendedProperties: { private: { campusnotehubBookingId: input.bookingId } },
      conferenceData: {
        createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    },
  });
  if (response.ok) return (await response.json()) as CalendarEvent;
  if (response.status !== 409) throw await failure(response, 'insert');

  // Already created by an earlier attempt.
  const existing = await getEvent(userId, input.eventId);
  if (existing?.status !== 'cancelled') {
    if (!existing) throw new CalendarApiError(404, true, 'event vanished after 409');
    return existing;
  }
  // The mentor deleted it from their calendar; the session is still on, so it comes back.
  const restored = await calendarFetch(userId, token, `${EVENTS_URL}/${input.eventId}?conferenceDataVersion=1&sendUpdates=none`, {
    method: 'PATCH',
    body: { status: 'confirmed' },
  });
  if (!restored.ok) throw await failure(restored, 'restore');
  return (await restored.json()) as CalendarEvent;
}

export async function getEvent(userId: string, eventId: string): Promise<CalendarEvent | null> {
  const token = await calendarAccessToken(userId);
  const response = await calendarFetch(userId, token, `${EVENTS_URL}/${eventId}`, { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, 'get');
  return (await response.json()) as CalendarEvent;
}

export async function deleteEvent(userId: string, eventId: string): Promise<void> {
  const token = await calendarAccessToken(userId);
  const response = await calendarFetch(userId, token, `${EVENTS_URL}/${eventId}?sendUpdates=none`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw await failure(response, 'delete');
}

/** The room URL, or null while Google is still creating the conference. */
export function meetUrlOf(event: CalendarEvent): string | null {
  if (event.conferenceData?.createRequest?.status?.statusCode === 'pending') return null;
  return (
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((point) => point.entryPointType === 'video')?.uri ??
    null
  );
}
