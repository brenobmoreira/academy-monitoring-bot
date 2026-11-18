"""Contract tests for the GitHub Pages Mini App deployment workflow (.github/workflows/pages.yml).

Validates workflow triggers, minimal permissions, action versions, staging coverage of all
production assets referenced by apps/miniapp/index.html and apps/miniapp/src/*.js, exclusion
of dev/test/demo files, and setup documentation in docs/setup/README.md.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.unit

AGENT_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_DIR.parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "pages.yml"
MINIAPP_DIR = REPO_ROOT / "apps" / "miniapp"

PRODUCTION_FILES = {
    "index.html",
    "styles.css",
    "assets/shape.svg",
    "data/foods.taco.json",
    "src/app.js",
    "src/avatar.js",
    "src/body.js",
    "src/core.js",
    "src/motion.js",
    "src/muscle-motion.js",
    "src/voice.js",
}


def _load_workflow() -> dict[str, Any]:
    assert WORKFLOW_PATH.is_file(), f"Expected {WORKFLOW_PATH} to exist"
    parsed = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict), "pages.yml must parse as a YAML mapping"
    return parsed


def _get_triggers(parsed: dict[str, Any]) -> dict[str, Any]:
    # PyYAML 1.1 may parse bare `on:` as boolean True
    triggers = parsed.get("on") if "on" in parsed else parsed.get(True)
    assert isinstance(triggers, dict), "pages.yml must define an 'on' mapping"
    return triggers


def test_pages_workflow_structure_and_permissions() -> None:
    parsed = _load_workflow()

    assert parsed.get("name") == "Deploy Mini App (Pages)"

    triggers = _get_triggers(parsed)
    assert "workflow_dispatch" in triggers, "pages.yml must support workflow_dispatch"
    push_cfg = triggers.get("push", {})
    assert isinstance(push_cfg, dict)
    assert push_cfg.get("branches") == ["main"]
    paths = push_cfg.get("paths", [])
    assert "apps/miniapp/**" in paths
    assert ".github/workflows/pages.yml" in paths

    # Minimal top-level permissions
    assert parsed.get("permissions") == {"contents": "read"}

    # Concurrency group
    assert parsed.get("concurrency") == {"group": "pages", "cancel-in-progress": False}

    jobs = parsed.get("jobs", {})
    assert "deploy" in jobs, "pages.yml must define a 'deploy' job"
    deploy_job = jobs["deploy"]
    assert deploy_job.get("permissions") == {
        "pages": "write",
        "id-token": "write",
    }


def test_pages_workflow_uses_verified_action_versions_and_gates() -> None:
    parsed = _load_workflow()
    steps = parsed["jobs"]["deploy"]["steps"]

    uses_list = [step.get("uses") for step in steps if "uses" in step]
    assert "actions/checkout@v7" in uses_list
    assert "actions/setup-node@v7" in uses_list
    assert "actions/configure-pages@v6" in uses_list
    assert "actions/upload-pages-artifact@v5" in uses_list
    assert "actions/deploy-pages@v5" in uses_list

    setup_node = next(s for s in steps if s.get("uses") == "actions/setup-node@v7")
    assert setup_node.get("with", {}).get("node-version") == 22

    upload_step = next(s for s in steps if s.get("uses") == "actions/upload-pages-artifact@v5")
    assert upload_step.get("with", {}).get("path") == "_site"

    run_scripts = "\n".join(step.get("run", "") for step in steps if "run" in step)
    assert "npm run check" in run_scripts
    assert "node --test apps/miniapp/test/*.test.js" in run_scripts
    assert "_site/.nojekyll" in run_scripts


def test_pages_workflow_stages_all_referenced_assets_and_excludes_dev_files() -> None:
    parsed = _load_workflow()
    steps = parsed["jobs"]["deploy"]["steps"]
    run_scripts = "\n".join(step.get("run", "") for step in steps if "run" in step)

    # 1. Every production file exists on disk and is staged by pages.yml
    for rel_path in sorted(PRODUCTION_FILES):
        full_path = MINIAPP_DIR / rel_path
        assert full_path.is_file(), f"Missing Mini App production file: {full_path}"
        assert f"apps/miniapp/{rel_path}" in run_scripts, f"pages.yml must stage apps/miniapp/{rel_path}"

    # 2. Inspect apps/miniapp/index.html for local href/src references
    index_html = (MINIAPP_DIR / "index.html").read_text(encoding="utf-8")
    local_refs = [
        ref
        for ref in re.findall(r'(?:href|src)="([^"]+)"', index_html)
        if not ref.startswith(("http://", "https://", "#", "data:"))
    ]
    assert local_refs, "Expected local asset/script references in apps/miniapp/index.html"

    for ref in local_refs:
        normalized = ref.removeprefix("./")
        if normalized.startswith("dev/"):
            # dev/ scripts (like dev/voice-stub.js) are local preview-only and excluded from _site
            assert "test ! -d _site/dev" in run_scripts
            continue
        assert normalized in PRODUCTION_FILES, (
            f"index.html references '{normalized}' which is not in PRODUCTION_FILES"
        )

    # 3. Inspect apps/miniapp/styles.css for local url(...) references (excluding SVG #fragments)
    styles_css = (MINIAPP_DIR / "styles.css").read_text(encoding="utf-8")
    css_urls = [
        u.strip("\"' ")
        for u in re.findall(r"url\(([^)]+)\)", styles_css)
        if not u.strip("\"' ").startswith(("#", "data:", "http://", "https://"))
    ]
    for css_ref in css_urls:
        normalized = css_ref.removeprefix("./")
        assert normalized in PRODUCTION_FILES, (
            f"styles.css references '{normalized}' which is not in PRODUCTION_FILES"
        )

    # 4. Inspect apps/miniapp/src/*.js for relative data/ or assets/ fetch paths
    for js_file in sorted((MINIAPP_DIR / "src").glob("*.js")):
        rel_js = f"src/{js_file.name}"
        assert rel_js in PRODUCTION_FILES, (
            f"New script apps/miniapp/{rel_js} must be added to PRODUCTION_FILES and pages.yml"
        )
        js_content = js_file.read_text(encoding="utf-8")
        for asset_ref in re.findall(r"['\"]((?:\./)?(?:data|assets)/[^'\"]+)['\"]", js_content):
            normalized = asset_ref.removeprefix("./")
            assert normalized in PRODUCTION_FILES, (
                f"{rel_js} references '{normalized}' which is not in PRODUCTION_FILES"
            )

    # 5. Explicitly verify exclusions in the workflow shell gate
    for check in (
        "test ! -d _site/dev",
        "test ! -d _site/test",
        "test ! -f _site/motion-demo.html",
        "test -f _site/index.html",
        "test -f _site/.nojekyll",
    ):
        assert check in run_scripts, f"pages.yml must enforce shell check: {check}"


def test_setup_readme_documents_miniapp_github_pages() -> None:
    readme = (REPO_ROOT / "docs" / "setup" / "README.md").read_text(encoding="utf-8")

    assert "Mini App (GitHub Pages)" in readme
    assert "GitHub Actions" in readme
    assert "Deploy Mini App (Pages)" in readme
    assert "MINIAPP_URL=https://<owner>.github.io/<repo>/" in readme
    assert "VOICE_ALLOWED_ORIGINS=https://<owner>.github.io" in readme
