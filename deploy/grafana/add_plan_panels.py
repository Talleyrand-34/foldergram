#!/usr/bin/env python3
"""
Rebuilds the row of the plan in the Foldergram AI dashboard.

The row answers "what is the limit, and how hard is the queue working
against it": what is left of each window, how long it lasts, whether
somebody else is in the pool, how much room there is and how many videos
are being analysed at the same time.

The script is idempotent: the panels of the row are rebuilt from scratch
every time, so running it twice gives the same dashboard.
"""

import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "deploy/grafana/foldergram-ai.json"

DS = {"type": "prometheus", "uid": "PAE45454D0EDB9216"}
ROW_TITLE = "The plan - the limit that applies"

# The titles of the panels this row owns.
OWNED = [
    "5-hour window left",
    "The week left",
    "The 5-hour window lasts",
    "The week lasts",
    "Shared with somebody?",
    "The window resets in",
    "The room there is",
    "Videos at a time",
    "What is left of the plan",
    "How long it lasts at this rate",
    "Is somebody else in the plan",
    "How to read this row",
]


def target(expr, legend, instant=False):
    t = {
        "datasource": DS,
        "editorMode": "code",
        "expr": expr,
        "legendFormat": legend,
        "range": not instant,
        "refId": "A",
    }
    if instant:
        t["instant"] = True
    return t


def thresholds(steps, unit="short"):
    return {
        "defaults": {
            "color": {"mode": "thresholds"},
            "mappings": [],
            "thresholds": {"mode": "absolute", "steps": steps},
            "unit": unit,
        },
        "overrides": [],
    }


def stat(pid, title, expr, legend, x, y, unit="short", steps=None, decimals=None, description=None):
    cfg = thresholds(steps or [{"color": "green", "value": None}], unit)
    if decimals is not None:
        cfg["defaults"]["decimals"] = decimals

    panel = {
        "datasource": DS,
        "fieldConfig": cfg,
        "gridPos": {"h": 4, "w": 4, "x": x, "y": y},
        "id": pid,
        "options": {
            "colorMode": "value",
            "graphMode": "area",
            "justifyMode": "auto",
            "orientation": "auto",
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "textMode": "auto",
            "wideLayout": True,
        },
        "pluginVersion": "11.0.0",
        "targets": [target(expr, legend, instant=True)],
        "title": title,
        "type": "stat",
    }
    if description:
        panel["description"] = description
    return panel


def timeseries(pid, title, targets, x, y, unit="short", description=None):
    panel = {
        "datasource": DS,
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "axisBorderShow": False,
                    "axisCenteredZero": False,
                    "axisColorMode": "text",
                    "axisLabel": "",
                    "axisPlacement": "auto",
                    "barAlignment": 0,
                    "drawStyle": "line",
                    "fillOpacity": 8,
                    "gradientMode": "none",
                    "hideFrom": {"legend": False, "tooltip": False, "viz": False},
                    "insertNulls": False,
                    "lineInterpolation": "smooth",
                    "lineWidth": 2,
                    "pointSize": 5,
                    "scaleDistribution": {"type": "linear"},
                    "showPoints": "never",
                    "spanNulls": True,
                    "stacking": {"group": "A", "mode": "none"},
                    "thresholdsStyle": {"mode": "off"},
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]},
                "unit": unit,
            },
            "overrides": [],
        },
        "gridPos": {"h": 8, "w": 8, "x": x, "y": y},
        "id": pid,
        "options": {
            "legend": {
                "calcs": ["lastNotNull", "max"],
                "displayMode": "table",
                "placement": "bottom",
                "showLegend": True,
            },
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
        "pluginVersion": "11.0.0",
        "targets": targets,
        "title": title,
        "type": "timeseries",
    }
    if description:
        panel["description"] = description
    return panel


def text(pid, title, content, x, y, w=24, h=4):
    return {
        "datasource": DS,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "id": pid,
        "options": {
            "code": {"language": "plaintext", "showLineNumbers": False, "showMiniMap": False},
            "content": content,
            "mode": "markdown",
        },
        "pluginVersion": "11.0.0",
        "title": title,
        "type": "text",
    }


def build():
    """The panels of the row, from scratch."""
    plan = "foldergram_ai_plan_remaining_percent"
    time_left = "foldergram_ai_plan_time_left_hours"
    contended = 'foldergram_ai_plan_contended{provider=~"$provider"}'
    rolls_over = "foldergram_ai_plan_rolls_over_in_seconds"
    room = 'foldergram_ai_plan_room_ratio{provider=~"$provider"}'
    concurrency = "foldergram_ai_analysis_concurrency"

    def match(metric, window):
        """One label matcher block: two of them in a row is not PromQL."""
        return f'{metric}{{provider=~"$provider", window="{window}"}}'

    panels = [
        {
            "collapsed": False,
            "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            "id": 200,
            "panels": [],
            "title": ROW_TITLE,
            "type": "row",
        },
        stat(201, "5-hour window left", f"max by (provider) ({match(plan, 'interval')})",
             "left", 0, 1, unit="percent",
             steps=[{"color": "red", "value": None}, {"color": "orange", "value": 10},
                    {"color": "yellow", "value": 25}, {"color": "green", "value": 50}]),
        stat(202, "The week left", f"max by (provider) ({match(plan, 'weekly')})",
             "left", 4, 1, unit="percent",
             steps=[{"color": "red", "value": None}, {"color": "orange", "value": 10},
                    {"color": "yellow", "value": 25}, {"color": "green", "value": 50}]),
        stat(203, "The 5-hour window lasts", f"max by (provider) ({match(time_left, 'interval')})",
             "left", 8, 1, unit="h",
             steps=[{"color": "red", "value": None}, {"color": "orange", "value": 1},
                    {"color": "green", "value": 6}], decimals=1),
        stat(204, "The week lasts", f"max by (provider) ({match(time_left, 'weekly')})",
             "left", 12, 1, unit="h",
             steps=[{"color": "red", "value": None}, {"color": "orange", "value": 24},
                    {"color": "green", "value": 168}], decimals=1),
        stat(205, "Shared with somebody?", f"max by (provider) ({contended})",
             "shared", 16, 1,
             steps=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat(206, "The window resets in",
             f"max by (provider) ({match(rolls_over, 'interval')}) / 3600",
             "hours", 20, 1, unit="h", decimals=1),
        stat(207, "The room there is", f"max by (provider) ({room})",
             "room", 0, 5, decimals=2,
             steps=[{"color": "red", "value": None}, {"color": "orange", "value": 1},
                    {"color": "green", "value": 1.5}],
             description="How much faster the plan could be spent before its window runs out before it renews. Above 1 there is room to spare."),
        stat(208, "Videos at a time", f"max({concurrency})",
             "at a time", 4, 5,
             steps=[{"color": "green", "value": None}, {"color": "orange", "value": 2},
                    {"color": "red", "value": 4}],
             description="How many videos the queue analyses at the same time. It follows the room the plan leaves."),
        timeseries(209, "What is left of the plan",
                   [target(f'{plan}{{provider=~"$provider"}}', "{{provider}} - {{window}}")],
                   8, 5, unit="percent",
                   description="The plan's own number, read from the provider. It is the limit the queue obeys."),
        timeseries(210, "How long it lasts at this rate",
                   [target(f'{time_left}{{provider=~"$provider"}}', "{{provider}} - {{window}}")],
                   16, 5, unit="h",
                   description="What is left of each window divided by how fast it is being spent. Null while the plan is not being spent."),
        timeseries(211, "Is somebody else in the plan",
                   [target(contended, "{{provider}}")], 0, 13,
                   description="The plan is shared: the pool moved while nothing of ours was being sent. The queue yields half while that is so."),
        text(212, "How to read this row",
             "The **plan is the limit**, not the token budget in the settings.\n\n"
             "- The provider publishes how much of each window is left; the queue stops when a window has no room and carries on when it rolls over.\n"
             "- *Lasts* is what is left divided by how fast it is going: the answer to \"when does this run out\".\n"
             "- *Room* is how much faster the plan could be spent without running out before its window renews. Above 1 the queue works harder; below 1 it would exhaust the plan early and idle until the window rolls over.\n"
             "- *Videos at a time* is the queue following that room.\n"
             "- *Shared* means somebody else is in the plan: the queue takes only its share while that is so.",
             8, 13, w=16),
    ]

    return panels


def main():
    with open(PATH, encoding="utf-8") as handle:
        dashboard = json.load(handle)

    panels = dashboard.get("panels", [])
    row = next((p for p in panels if p.get("title") == ROW_TITLE), None)

    if row is None:
        print("la fila del plan no está")
        return 1

    # The row and the panels it owns are rebuilt from scratch, so the
    # dashboard ends up the same however many times this runs.
    row_index = panels.index(row)
    owned = [p for p in panels[row_index + 1 :] if p.get("title") in OWNED]

    new_panels = build()

    # How tall the row is now, and how tall it is going to be. Both are
    # measured, not written down, so the row can grow without anybody
    # having to remember to move the rest.
    row_y = row["gridPos"]["y"]
    old_height = (
        max(panel["gridPos"]["y"] + panel["gridPos"]["h"] for panel in owned + [row])
        - row_y
    )
    new_height = (
        max(panel["gridPos"]["y"] + panel["gridPos"]["h"] for panel in new_panels)
        - row_y
    )

    # What comes before the row stays where it is; what comes after it
    # moves down to make room.
    above = panels[:row_index]
    below = [p for p in panels[row_index + 1 :] if p.get("title") not in OWNED]

    shift = new_height - old_height
    if shift:
        for panel in below:
            panel["gridPos"]["y"] += shift

    # The ids must not collide.
    used = {p.get("id") for p in above + below}
    for panel in new_panels:
        while panel["id"] in used:
            panel["id"] += 1
        used.add(panel["id"])

    dashboard["panels"] = above + new_panels + below
    dashboard["version"] = dashboard.get("version", 1) + 1

    with open(PATH, "w", encoding="utf-8") as handle:
        json.dump(dashboard, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"la fila del plan tiene {len(new_panels)} paneles; el dashboard tiene {len(dashboard['panels'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
