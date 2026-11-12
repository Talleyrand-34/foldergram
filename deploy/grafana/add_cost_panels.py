#!/usr/bin/env python3
"""
Adds the panels that the plan's numbers make meaningful to the existing
rows of the Foldergram AI dashboard.

Two of them:

  - the cost of one analysis, which is what turns the plan's rate into
    something an operator can reason about
  - the pauses the plan's own wall caused, which are the queue obeying the
    limit rather than failing

The script is idempotent: running it twice does not add the panels twice.
"""

import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "deploy/grafana/foldergram-ai.json"

DS = {"type": "prometheus", "uid": "PAE45454D0EDB9216"}
COST_PANEL = "The cost of one analysis"
PLAN_PAUSES_PANEL = "Pauses by the plan's wall (24h)"


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


def stat(pid, title, expr, legend, grid, unit="short", steps=None, decimals=None):
    cfg = {
        "defaults": {
            "color": {"mode": "thresholds"},
            "mappings": [],
            "thresholds": {"mode": "absolute", "steps": steps or [{"color": "green", "value": None}]},
            "unit": unit,
        },
        "overrides": [],
    }
    if decimals is not None:
        cfg["defaults"]["decimals"] = decimals

    return {
        "datasource": DS,
        "fieldConfig": cfg,
        "gridPos": grid,
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


def main():
    with open(PATH, encoding="utf-8") as handle:
        dashboard = json.load(handle)

    panels = dashboard.get("panels", [])
    titles = {p.get("title") for p in panels}
    used_ids = {p.get("id") for p in panels}

    def free_id(start):
        candidate = start
        while candidate in used_ids:
            candidate += 1
        used_ids.add(candidate)
        return candidate

    added = []

    # The cost of one analysis, next to the token counters it explains.
    if COST_PANEL not in titles:
        # The "Cost - tokens" row: the row header is at the first y of the
        # row, its panels right below it.
        row = next(p for p in panels if p.get("title") == "Cost - tokens")
        row_y = row["gridPos"]["y"]
        stat_y = row_y + 1

        # Solo los análisis completados: uno que falló no gastó tokens,
        # y contarlo como si hubiera gastado abarata el análisis.
        expr = (
            'sum(rate(foldergram_ai_tokens_total{provider=~"$provider"}[1h]))'
            ' / clamp_min(sum(rate(foldergram_ai_analyses_total'
            '{provider=~"$provider", status="completed"}[1h])), 0.0001)'
        )

        panel = stat(
            free_id(300),
            COST_PANEL,
            expr,
            "tokens",
            {"h": 4, "w": 4, "x": 16, "y": stat_y},
            steps=[
                {"color": "green", "value": None},
                {"color": "orange", "value": 10000},
                {"color": "red", "value": 30000},
            ],
            decimals=0,
        )
        panel["description"] = (
            "What one analysis costs in tokens. The plan is spent at this rate, "
            "so this is the number that says how much of the plan each video takes."
        )
        panels.append(panel)
        added.append(COST_PANEL)

        # The text panel that was at x=16 moves to x=20, and the new one
        # takes its place, so nothing overlaps.
        for other in panels:
            if other.get("title") == "Why the token panels are empty":
                other["gridPos"]["x"] = 20
                other["gridPos"]["w"] = 4

    # The pauses the plan's wall caused.
    if PLAN_PAUSES_PANEL not in titles:
        row = next(p for p in panels if p.get("title") == "Errors and pipeline")
        row_y = row["gridPos"]["y"]
        stat_y = row_y + 1

        # The row has four columns of four panels each; the last free slot
        # of the first line is taken by finding a free x.
        taken = {
            (p["gridPos"].get("x"), p["gridPos"].get("y"))
            for p in panels
            if p.get("gridPos", {}).get("y") == stat_y
        }
        x = 0
        while (x, stat_y) in taken:
            x += 4
        if x > 20:
            x = 20

        panel = stat(
            free_id(310),
            PLAN_PAUSES_PANEL,
            'sum(increase(foldergram_ai_pauses_total{cause="usage_limit"}[24h])) or vector(0)',
            "pauses",
            {"h": 4, "w": 4, "x": x, "y": stat_y},
            steps=[
                {"color": "green", "value": None},
                {"color": "orange", "value": 1},
            ],
        )
        panel["description"] = (
            "Times the queue stopped because the plan had no room left. "
            "It lifts by itself when the window rolls over."
        )
        panels.append(panel)
        added.append(PLAN_PAUSES_PANEL)

    if added:
        dashboard["version"] = dashboard.get("version", 1) + 1
        with open(PATH, "w", encoding="utf-8") as handle:
            json.dump(dashboard, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

    print(f"añadidos: {added or 'nada (ya estaban)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
