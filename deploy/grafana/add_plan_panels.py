#!/usr/bin/env python3
"""
Adds the plan panels to the Foldergram AI dashboard.

The plan is the limit the queue obeys, and its state is published as
telemetry. These panels are what turn that into something an operator can
act on: what is left of each window, how long it lasts at the current
rate, and whether somebody else is in the pool.

The script is idempotent: running it twice does not add the panels twice.
"""

import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "deploy/grafana/foldergram-ai.json"

DS = {"type": "prometheus", "uid": "PAE45454D0EDB9216"}
ROW_TITLE = "The plan - the limit that applies"
ROW_ID = 200


def target(expr, legend, ref="A", instant=False):
    """A Prometheus target."""
    t = {
        "datasource": DS,
        "editorMode": "code",
        "expr": expr,
        "legendFormat": legend,
        "range": not instant,
        "refId": ref,
    }
    if instant:
        t["instant"] = True
    return t


def thresholds(steps, unit="short"):
    """The colour steps of a panel."""
    return {
        "defaults": {
            "color": {"mode": "thresholds"},
            "mappings": [],
            "thresholds": {"mode": "absolute", "steps": steps},
            "unit": unit,
        },
        "overrides": [],
    }


def stat(pid, title, expr, legend, x, unit="short", steps=None, decimals=None):
    """A single number."""
    cfg = thresholds(steps or [{"color": "green", "value": None}], unit)
    if decimals is not None:
        cfg["defaults"]["decimals"] = decimals
    return {
        "datasource": DS,
        "fieldConfig": cfg,
        "gridPos": {"h": 4, "w": 4, "x": x, "y": 1},
        "id": pid,
        "options": {
            "colorMode": "value",
            "graphMode": "area",
            "justifyMode": "auto",
            "orientation": "auto",
            "reduceOptions": {
                "calcs": ["lastNotNull"],
                "fields": "",
                "values": False,
            },
            "textMode": "auto",
            "wideLayout": True,
        },
        "pluginVersion": "11.0.0",
        "targets": [target(expr, legend, instant=True)],
        "title": title,
        "type": "stat",
    }


def timeseries(pid, title, targets, x, unit="short", description=None):
    """A chart."""
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
        "gridPos": {"h": 8, "w": 8, "x": x, "y": 5},
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


def text(pid, title, content, x, y, w=8, h=4):
    """A note."""
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
    """The panels of the plan row."""
    plan = "foldergram_ai_plan_remaining_percent"
    time_left = "foldergram_ai_plan_time_left_hours"
    contended = 'foldergram_ai_plan_contended{provider=~"$provider"}'
    rolls_over = "foldergram_ai_plan_rolls_over_in_seconds"

    def match(metric, window):
        """One label matcher block: two of them in a row is not PromQL."""
        return f'{metric}{{provider=~"$provider", window="{window}"}}'

    panels = [
        {
            "collapsed": False,
            "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            "id": ROW_ID,
            "panels": [],
            "title": ROW_TITLE,
            "type": "row",
        },
        stat(
            201,
            "5-hour window left",
            f"max by (provider) ({match(plan, 'interval')})",
            "left",
            0,
            unit="percent",
            steps=[
                {"color": "red", "value": None},
                {"color": "orange", "value": 10},
                {"color": "yellow", "value": 25},
                {"color": "green", "value": 50},
            ],
        ),
        stat(
            202,
            "The week left",
            f"max by (provider) ({match(plan, 'weekly')})",
            "left",
            4,
            unit="percent",
            steps=[
                {"color": "red", "value": None},
                {"color": "orange", "value": 10},
                {"color": "yellow", "value": 25},
                {"color": "green", "value": 50},
            ],
        ),
        stat(
            203,
            "The 5-hour window lasts",
            f"max by (provider) ({match(time_left, 'interval')})",
            "left",
            8,
            unit="h",
            steps=[
                {"color": "red", "value": None},
                {"color": "orange", "value": 1},
                {"color": "green", "value": 6},
            ],
            decimals=1,
        ),
        stat(
            204,
            "The week lasts",
            f"max by (provider) ({match(time_left, 'weekly')})",
            "left",
            12,
            unit="h",
            steps=[
                {"color": "red", "value": None},
                {"color": "orange", "value": 24},
                {"color": "green", "value": 168},
            ],
            decimals=1,
        ),
        stat(
            205,
            "Shared with somebody?",
            f'max by (provider) ({contended})',
            "shared",
            16,
            steps=[
                {"color": "green", "value": None},
                {"color": "red", "value": 1},
            ],
        ),
        stat(
            206,
            "The window resets in",
            f"max by (provider) ({match(rolls_over, 'interval')}) / 3600",
            "hours",
            20,
            unit="h",
            decimals=1,
        ),
        timeseries(
            207,
            "What is left of the plan",
            [target(f'{plan}{{provider=~"$provider"}}', "{{provider}} - {{window}}")],
            0,
            unit="percent",
            description="The plan's own number, read from the provider. It is the limit the queue obeys.",
        ),
        timeseries(
            208,
            "How long it lasts at this rate",
            [target(f'{time_left}{{provider=~"$provider"}}', "{{provider}} - {{window}}")],
            8,
            unit="h",
            description="What is left of each window divided by how fast it is being spent. Null while the plan is not being spent.",
        ),
        timeseries(
            209,
            "Is somebody else in the plan",
            [target(contended, "{{provider}}")],
            16,
            description="The plan is shared: the pool moved while nothing of ours was being sent. The queue yields half while that is so.",
        ),
    ]

    panels.append(
        text(
            210,
            "How to read this row",
            "The **plan is the limit**, not the token budget in the settings.\n\n"
            "- The provider publishes how much of each window is left; the queue stops when a window has no room and carries on when it rolls over.\n"
            "- *Lasts* is what is left divided by how fast it is going. It is the answer to \"when does this run out\".\n"
            "- *Shared* means the plan is being used by somebody else: the queue takes only its share while that is so.",
            0,
            13,
            w=24,
            h=4,
        )
    )
    return panels


def main():
    with open(PATH, encoding="utf-8") as handle:
        dashboard = json.load(handle)

    panels = dashboard.get("panels", [])

    # Already there? Nothing to do.
    if any(p.get("title") == ROW_TITLE for p in panels):
        print("la fila del plan ya está")
        return 0

    new_panels = build()

    # The new row takes 17 rows of height: everything else moves down.
    offset = 17
    for panel in panels:
        grid = panel.get("gridPos")
        if grid and "y" in grid:
            grid["y"] += offset

    # The ids must not collide.
    used = {p.get("id") for p in panels}
    for panel in new_panels:
        while panel["id"] in used:
            panel["id"] += 1
        used.add(panel["id"])

    dashboard["panels"] = new_panels + panels
    dashboard["version"] = dashboard.get("version", 1) + 1

    with open(PATH, "w", encoding="utf-8") as handle:
        json.dump(dashboard, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"{len(new_panels)} paneles añadidos; el dashboard tiene {len(dashboard['panels'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
