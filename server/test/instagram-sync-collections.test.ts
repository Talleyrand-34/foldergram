import { describe, expect, it } from 'vitest';

import {
  collectionUrl,
  instagramUsername,
  parseCollectionsOutput,
  type InstagramCollection
} from '../../plugins/instagram-sync/src/instagramCollections.js';

const SOURCE = 'https://www.instagram.com/rodantes_6/saved/';

describe('instagram-sync collection helpers', () => {
  it('derives the account from the source URL', () => {
    expect(instagramUsername(SOURCE)).toBe('rodantes_6');
    expect(instagramUsername('https://www.instagram.com/other/saved/')).toBe('other');
    expect(instagramUsername('not-a-url')).toBeNull();
  });

  it('builds the URL gallery-dl needs for a collection', () => {
    const collection: InstagramCollection = {
      id: '18108037513940688',
      name: 'repo',
      type: 'MediaCollection',
      isAuto: false
    };
    expect(collectionUrl(SOURCE, collection)).toBe(
      'https://www.instagram.com/rodantes_6/saved/repo/18108037513940688/'
    );
  });

  it('parses the helper output', () => {
    const stdout = [
      'some other log line',
      'COLLECTIONS_JSON=[{"id":"18108037513940688","name":"repo","type":"MediaCollection","isAuto":false},',
      '{"id":"ALL_MEDIA_AUTO_COLLECTION","name":"All posts","type":"IGAllMediaAutoCollection","isAuto":true}]'
    ].join('\n');

    const collections = parseCollectionsOutput(stdout);
    expect(collections).toHaveLength(2);
    expect(collections[0]).toEqual({
      id: '18108037513940688',
      name: 'repo',
      type: 'MediaCollection',
      isAuto: false
    });
    expect(collections[1].isAuto).toBe(true);
  });

  it('rejects helper output with no payload', () => {
    expect(() => parseCollectionsOutput('nothing here')).toThrow(/no output/);
  });

  it('drops entries without an id or a name', () => {
    const stdout =
      'COLLECTIONS_JSON=[{"id":"1","name":"ok"},{"id":"","name":"no id"},{"id":"3"}]';
    const collections = parseCollectionsOutput(stdout);
    expect(collections).toHaveLength(1);
    expect(collections[0].name).toBe('ok');
  });
});
