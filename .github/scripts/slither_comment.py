"""Generate a Markdown PR comment from a slither-results.json file.

Usage:
    python3 slither_comment.py <repo> <sha> <run_id> <server_url> <target> <base_path>

Outputs the comment body to stdout.
"""

import json
import re
import sys

repo, sha, run_id, server_url, target, base_path = sys.argv[1:7]

with open("slither-results.json") as f:
    data = json.load(f)

detectors = data.get("results", {}).get("detectors", [])

counts = {"High": 0, "Medium": 0, "Low": 0, "Informational": 0, "Optimization": 0}
for d in detectors:
    impact = d.get("impact", "")
    if impact in counts:
        counts[impact] += 1

high = counts["High"]
medium = counts["Medium"]
low = counts["Low"]
info = counts["Informational"] + counts["Optimization"]

if high > 0:
    status = f"**{high} high-severity** finding(s) — action required"
    status_icon = "🔴"
elif medium > 0:
    status = f"**{medium} medium**, {low} low, {info} informational"
    status_icon = "🟡"
elif low + info > 0:
    status = f"{low} low, {info} informational — no action required"
    status_icon = "🟢"
else:
    status = "Clean — no findings"
    status_icon = "🟢"

SEVERITY_TAG = {
    "High": "🔴 High",
    "Medium": "🟡 Medium",
    "Low": "🟠 Low",
    "Informational": "ℹ️ Info",
    "Optimization": "⚙️ Opt",
}


def make_link(filepath, start, end=None):
    """Build a GitHub permalink for a source location."""
    full_path = base_path + filepath if not filepath.startswith(base_path) else filepath
    url = f"{server_url}/{repo}/blob/{sha}/{full_path}#L{start}"
    label = f"{filepath}#L{start}"
    if end:
        url += f"-L{end}"
        label += f"-L{end}"
    return f"[`{label}`]({url})"


def linkify(text):
    """Replace (file.sol#L-L) refs with clickable GitHub permalinks."""

    def replace(m):
        return make_link(m.group(1), m.group(2), m.group(3))

    return re.sub(r"\(([^\s()]+\.sol)#(\d+)(?:-(\d+))?\)", replace, text)


def format_description(description):
    """Clean up Slither description into readable markdown."""
    # Split into lines and clean up
    lines = description.strip().split("\n")
    formatted = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Indent sub-items (lines starting with - or tab)
        if line.startswith("-") or line.startswith("\t"):
            line = line.lstrip("\t -")
            formatted.append(f"  - `{line}`")
        else:
            formatted.append(line)

    result = "\n".join(formatted)
    return linkify(result)


def render_finding(d):
    """Render a single finding as a details block."""
    severity = d.get("impact", "")
    check = d.get("check", "")
    description = d.get("description", "").strip()
    elements = d.get("elements", [])
    tag = SEVERITY_TAG.get(severity, severity)
    wiki_url = f"https://github.com/crytic/slither/wiki/Detector-Documentation#{check}"

    # Get primary element name for the summary line
    primary = next(
        (e for e in elements if e.get("type") in ("function", "contract")),
        elements[0] if elements else None,
    )
    primary_name = primary.get("name", "") if primary else ""

    # Get source location from primary element
    src = ""
    if primary and "source_mapping" in primary:
        sm = primary["source_mapping"]
        filename = sm.get("filename_short", "")
        start_line = sm.get("lines", [None])[0]
        end_line = sm.get("lines", [None])[-1] if sm.get("lines") else None
        if filename and start_line:
            src = f" in {make_link(filename, start_line, end_line if end_line != start_line else None)}"

    # Use HTML inside <summary> — markdown doesn't render there
    summary = f"<strong>{tag}</strong> · <a href=\"{wiki_url}\"><code>{check}</code></a>"
    if primary_name:
        summary += f" — <code>{primary_name}</code>"

    body = format_description(description)
    if src:
        body = f"📍 {src}\n\n{body}"

    return f"<details>\n<summary>{summary}</summary>\n\n{body}\n\n</details>"


# --- Build comment ---

lines = [
    f"## {status_icon} Slither — {target}",
    "",
    status,
    "",
]

# Show high/medium findings in detail
important = [d for d in detectors if d.get("impact") in ("High", "Medium")]
if important:
    lines.append("### Findings\n")
    for d in important:
        lines.append(render_finding(d))
        lines.append("")

# Group low/info into a single collapsed section
minor = [d for d in detectors if d.get("impact") not in ("High", "Medium")]
if minor:
    # Group by check type
    by_check = {}
    for d in minor:
        check = d.get("check", "unknown")
        by_check.setdefault(check, []).append(d)

    lines.append(f"<details>\n<summary><strong>{len(minor)} low/informational findings</strong></summary>\n")
    lines.append("| Severity | Detector | Count |")
    lines.append("|----------|----------|-------|")
    for check, items in sorted(by_check.items(), key=lambda x: -len(x[1])):
        severity = items[0].get("impact", "")
        tag = SEVERITY_TAG.get(severity, severity)
        wiki_url = f"https://github.com/crytic/slither/wiki/Detector-Documentation#{check}"
        lines.append(f"| {tag} | [`{check}`]({wiki_url}) | {len(items)} |")
    lines.append("\n</details>")

lines += [
    "",
    f"<sub>[Workflow logs]({server_url}/{repo}/actions/runs/{run_id})</sub>",
]

print("\n".join(lines))
