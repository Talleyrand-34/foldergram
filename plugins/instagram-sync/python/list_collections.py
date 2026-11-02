#!/usr/bin/env python3
"""List the logged-in user's Instagram saved collections.

Reuses gallery-dl's own Instagram machinery — cookie handling, `lsd`/`fb_dtsg`
token extraction, GraphQL request signing — so it stays in step with the
vendored gallery-dl version instead of re-implementing Instagram's auth.

gallery-dl has no extractor for saved *collections* (it has one for saved posts
and one for a collection's contents), so the GraphQL query is driven from here.

The query's `doc_id` is normally discovered by scanning Instagram's JS bundles.
The saved-collections query lives in a lazily-loaded chunk, so discovery raises
KeyError; the known id is used as a fallback instead. If Instagram rotates it,
this fails with a clear message and the id has to be updated here.

Usage:
    python3 list_collections.py <cookie-file> <instagram-username>

Prints a JSON array of {id, name, type} on stdout.
"""

import json
import re
import sys

from gallery_dl import config, job
from gallery_dl.extractor.instagram import QUERIES, InstagramAPI, InstagramExtractor

OPNAME = "PolarisProfileSavedTabContentQuery"

# Fallback only — gallery-dl discovers the live doc_id from Instagram's JS when
# the query's registration is in the page's initial bundles. It usually is not.
DOC_ID = "27584326974521636"

VARIABLES = {
    "collection_types": [
        "ALL_MEDIA_AUTO_COLLECTION",
        "PLAYLIST_AUTO_COLLECTION",
        "MEDIA",
        "AUDIO_AUTO_COLLECTION",
    ],
    "first": 100,
}

# Instagram's auto-collection for everything the user saved.
ALL_MEDIA = "ALL_MEDIA_AUTO_COLLECTION"


def _extract_or_fallback(self, opname, path):
    try:
        return self._original_extract_opname_info(opname, path)
    except KeyError:
        # The query is not in the page's initial bundles; use the known id.
        return (QUERIES.get(opname), None)


def _install_fallback():
    if not hasattr(InstagramAPI, "_original_extract_opname_info"):
        InstagramAPI._original_extract_opname_info = InstagramAPI._extract_opname_info
        InstagramAPI._extract_opname_info = _extract_or_fallback


class CollectionListExtractor(InstagramExtractor):
    pattern = r"instagram:(collections)"

    def items(self):
        data = self.api._call_graphql(OPNAME, VARIABLES)
        edges = (
            data.get("viewer", {})
            .get("collections_unified_with_auto_collections", {})
            .get("edges", [])
        )

        collections = []
        for edge in edges:
            node = edge.get("node", {})
            collection_id = node.get("collection_id")
            name = node.get("collection_name")
            if not collection_id or not name:
                continue
            collections.append({
                "id": str(collection_id),
                "name": name,
                "type": node.get("__typename") or "",
                "isAuto": collection_id == ALL_MEDIA,
            })

        sys.stdout.write("COLLECTIONS_JSON=" + json.dumps(collections))
        return iter(())


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: list_collections.py <cookie-file> <username>\n")
        return 2

    cookie_file, username = sys.argv[1], sys.argv[2]

    QUERIES[OPNAME] = DOC_ID
    _install_fallback()

    config.initialize()
    config.set(("extractor",), "cookies", cookie_file)

    match = re.compile(r"instagram:(collections)").match("instagram:collections")
    extr = CollectionListExtractor(match)
    job.DownloadJob(extr).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
