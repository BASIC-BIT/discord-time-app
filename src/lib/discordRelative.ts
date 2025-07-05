import moment from 'moment/min/moment-with-locales';

// Match Discord rounding (round *up* to nearest unit)
moment.relativeTimeRounding(Math.round);

/** Convert Unix seconds to Discord-style "in 3 hours / 2 days ago". */
export const discordRelative = (unix: number): string =>
  moment.unix(unix).fromNow(); 