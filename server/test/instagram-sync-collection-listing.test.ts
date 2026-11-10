import { describe, expect, it } from 'vitest';

import {
  parseListingLine,
  trackKnownMedia,
  type KnownProgress
} from '../../plugins/instagram-sync/src/instagramCollections.js';
import { mediaIdOf } from '../../plugins/instagram-sync/src/collectionMirror.js';

/**
 * The listing of a collection.
 *
 * gallery-dl marks a media it did not fetch with a "# " prefix — it is
 * already in the library. It is **still a member of the collection**, so
 * its path has to be kept: the mirror files the media of a collection, and
 * the media that are already downloaded are exactly the ones it has to
 * place. Dropping them left every collection empty of its newest posts.
 */
describe('a collection listing', () => {
  it('reads a media that was not skipped', () => {
    const line = parseListingLine('/listing/alex/4024.mp4');
    expect(line).toEqual({ path: '/listing/alex/4024.mp4', skipped: false });
  });

  it('reads a media that was skipped — and keeps its path', () => {
    const line = parseListingLine('# /listing/alex/4024.mp4');
    expect(line).toEqual({ path: '/listing/alex/4024.mp4', skipped: true });
  });

  it('ignores an empty line', () => {
    expect(parseListingLine('')).toBeNull();
    expect(parseListingLine('   ')).toBeNull();
  });

  it('does not mistake a "#" in a path for a skip', () => {
    // A path may hold a "#" — only the "# " prefix marks a skip.
    const line = parseListingLine('/listing/alex/40#24.mp4');
    expect(line).toEqual({ path: '/listing/alex/40#24.mp4', skipped: false });
  });
});

/**
 * When the enumeration stops.
 *
 * The criterion is "this many already-filed media **in a row**". It is not
 * "already downloaded": a collection is ordered by the date of the post and
 * not by the day it was saved, so a post saved today but posted long ago
 * sits deep in the collection — a budget that counted downloads would never
 * reach it, and the post would never be filed.
 */
describe('when the enumeration stops', () => {
  const known = new Set(['a/1.mp4', 'a/2.mp4', 'a/3.mp4']);
  const start: KnownProgress = { known: 0, run: 0, reached: 0, caughtUp: false };

  it('keeps going while the media are new', () => {
    const state = trackKnownMedia(start, 'b/9.mp4', known, 3);
    expect(state.run).toBe(0);
    expect(state.caughtUp).toBe(false);
  });

  it('counts the media it already holds', () => {
    const state = trackKnownMedia(start, 'a/1.mp4', known, 3);
    expect(state.known).toBe(1);
    expect(state.run).toBe(1);
    expect(state.caughtUp).toBe(false);
  });

  it('stops when enough of them come in a row', () => {
    let state = trackKnownMedia(start, 'a/1.mp4', known, 3);
    state = trackKnownMedia(state, 'a/2.mp4', known, 3);
    expect(state.caughtUp).toBe(false);
    state = trackKnownMedia(state, 'a/3.mp4', known, 3);
    expect(state.caughtUp).toBe(true);
  });

  it('does not stop when a new media breaks the run', () => {
    // The new post sits between the old ones: the run is broken, so the
    // enumeration goes on.
    let state = trackKnownMedia(start, 'a/1.mp4', known, 2);
    state = trackKnownMedia(state, 'b/9.mp4', known, 2);
    expect(state.run).toBe(0);
    expect(state.caughtUp).toBe(false);
    state = trackKnownMedia(state, 'a/2.mp4', known, 2);
    expect(state.caughtUp).toBe(false);
  });

  it('waits for the media the general sync just downloaded', () => {
    // The media that are in the library but not yet in the collection must
    // be reached, however deep they are: a collection is ordered by the date
    // of the post, so one that was posted long ago and saved yesterday sits
    // deep in the list.
    const pending = new Set(['b/9.mp4']);
    const known = new Set(['a/1.mp4', 'a/2.mp4', 'a/3.mp4', 'a/4.mp4']);
    let state = trackKnownMedia(start, 'a/1.mp4', known, 2, pending, 1);
    state = trackKnownMedia(state, 'a/2.mp4', known, 2, pending, 1);
    // The run of already-filed media is long enough — but the media that had
    // to be reached has not been seen, so the enumeration goes on.
    expect(state.caughtUp).toBe(false);

    state = trackKnownMedia(state, 'b/9.mp4', known, 2, pending, 1);
    expect(state.reached).toBe(1);
    expect(state.caughtUp).toBe(false);

    // The new media broke the run of filed media, so it starts again: the
    // enumeration only stops once the filed media come in a row **and**
    // everything that had to be reached has been seen.
    state = trackKnownMedia(state, 'a/3.mp4', known, 2, pending, 1);
    expect(state.caughtUp).toBe(false);
    state = trackKnownMedia(state, 'a/4.mp4', known, 2, pending, 1);
    expect(state.caughtUp).toBe(true);
  });

  it('never stops when the budget is zero', () => {
    let state = trackKnownMedia(start, 'a/1.mp4', known, 0);
    state = trackKnownMedia(state, 'a/2.mp4', known, 0);
    expect(state.caughtUp).toBe(false);
  });
});

/**
 * The identity of a media.
 *
 * The extension is not part of it: Instagram serves the same post as a `.jpg`
 * one day and as a `.heic` the next, and the library keeps the file it
 * downloaded first. Matching the whole path left those media in the library
 * and out of the collection.
 */
describe('the identity of a media', () => {
  it('is the file name without its extension', () => {
    expect(mediaIdOf('alexlexobx1/4024076724918819479.jpg')).toBe(
      '4024076724918819479'
    );
    expect(mediaIdOf('alexlexobx1/4024076724918819479.heic')).toBe(
      '4024076724918819479'
    );
  });

  it('is the same whatever extension Instagram serves', () => {
    expect(mediaIdOf('alexlexobx1/4024076724918819479.jpg')).toBe(
      mediaIdOf('alexlexobx1/4024076724918819479.heic')
    );
  });

  it('keeps a name that has no extension', () => {
    expect(mediaIdOf('folder/1234567890')).toBe('1234567890');
  });

  it('handles a name with several dots', () => {
    expect(mediaIdOf('folder/1234567890.tar.gz')).toBe('1234567890.tar');
  });
});
