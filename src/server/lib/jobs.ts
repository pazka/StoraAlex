// Background jobs, one line at start and one at end with dur_ms and counts (logging standard,
// pazka/hosh-management AGENTS.md section 11).
import type { Repos } from '../db/repos.js';
import { errField, type Logger } from './log.js';

/** Deletes expired sessions. Never throws. */
export function pruneSessions(repos: Repos, logger: Logger): void {
  const t0 = performance.now();
  const dur = () => Math.round(performance.now() - t0);
  logger.debug('session_prune_start', 'session prune started');
  try {
    const deleted = repos.sessions.deleteExpired();
    logger.info('session_prune_done', 'session prune done', { dur_ms: dur(), deleted });
  } catch (err) {
    logger.warn('session_prune_failed', 'session prune failed', { dur_ms: dur(), ...errField(err) });
  }
}
