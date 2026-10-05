"""MkDocs hooks for the documentation site (mkdocs.yml -> hooks:).

The site is built from docs/guide/, but the pages are written to read correctly
on github.com as well. So every link in them is a plain, repository-relative
Markdown link, and this hook translates those links for the site:

* a link to another guide page, or to a screenshot in docs/images/, stays a
  relative link to the copy the site publishes;
* a link to anything else in the repository -- DEPLOYMENT.md, the ADRs,
  scripts/deploy.sh, .env.example -- becomes a link to that file on GitHub,
  because the site does not publish it;
* a link to a file that does not exist anywhere in the repository is logged
  as a warning, which `mkdocs build --strict` turns into a failed build.

The screenshots live in docs/images/ because the README and the reference
guide use them too. on_files adds them to the site so the guide pages can show
them without a second copy in the repository.

Kept as a hook rather than a plugin package: it is one file, it is specific to
this repository's layout, and it needs nothing installed beyond MkDocs.
"""

from __future__ import annotations

import logging
import posixpath
import re
from pathlib import Path
from urllib.parse import quote, unquote

from mkdocs.structure.files import File, Files

# Under the "mkdocs" logger, so --strict counts these warnings as failures.
log = logging.getLogger("mkdocs.hooks.nexuspuppet")

BLOB = "https://github.com/eth-man/nexuspuppet/blob/main/"
TREE = "https://github.com/eth-man/nexuspuppet/tree/main/"

# Inline links and images: [text](target "title") / ![alt](target).
INLINE = re.compile(r"(\]\()(<?)([^)\s>]+)(>?)((?:\s+\"[^\"]*\")?\))")
# Reference definitions: [label]: target
REFDEF = re.compile(r"^( {0,3}\[[^\]]+\]:[ \t]*)(<?)(\S+?)(>?)(\s.*)?$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")

_repo: Path = Path()
_docs_rel = ""  # docs_dir relative to the repository root, e.g. "docs/guide"
_site: dict[str, str] = {}  # repository path -> path inside the site


def on_config(config):
    global _repo, _docs_rel
    _repo = Path(config.config_file_path).resolve().parent
    _docs_rel = Path(config.docs_dir).resolve().relative_to(_repo).as_posix()
    return config


def on_files(files: Files, config) -> Files:
    """Publish docs/images/ beside the guide, and record what the site holds."""
    images = _repo / "docs" / "images"
    for png in sorted(images.glob("*.png")):
        files.append(
            File(
                f"images/{png.name}",
                src_dir=str(images.parent),
                dest_dir=config.site_dir,
                use_directory_urls=config.use_directory_urls,
            )
        )

    _site.clear()
    for file in files:
        if file.src_uri.startswith("images/"):
            _site[f"docs/{file.src_uri}"] = file.src_uri
        else:
            _site[posixpath.join(_docs_rel, file.src_uri)] = file.src_uri
    return files


def on_page_markdown(markdown: str, page, config, files) -> str:
    page_repo_dir = posixpath.dirname(posixpath.join(_docs_rel, page.file.src_uri))
    page_site_dir = posixpath.dirname(page.file.src_uri)

    def rewrite(target: str) -> str:
        if target.startswith(("#", "/")) or SCHEME.match(target):
            return target
        path, hash_, fragment = target.partition("#")
        if path == "":
            return target
        repo_path = posixpath.normpath(posixpath.join(page_repo_dir, unquote(path)))
        if repo_path.startswith("../"):
            log.warning("%s: link '%s' leaves the repository", page.file.src_uri, target)
            return target

        if repo_path in _site:
            site_target = posixpath.relpath(_site[repo_path], page_site_dir or ".")
            return site_target + hash_ + fragment

        on_disk = _repo / repo_path
        if not on_disk.exists():
            log.warning(
                "%s: link '%s' points at %s, which does not exist in the repository",
                page.file.src_uri,
                target,
                repo_path,
            )
            return target
        base = TREE if on_disk.is_dir() else BLOB
        return base + quote(repo_path) + hash_ + fragment

    out: list[str] = []
    fence: str | None = None
    previous = ""
    for number, line in enumerate(markdown.split("\n"), start=1):
        if fence is None:
            _check_list_syntax(page.file.src_uri, number, previous, line)
            previous = line
        marker = FENCE.match(line)
        if fence is not None:
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                fence = None
            out.append(line)
            continue
        if marker:
            fence = marker.group(1)
            out.append(line)
            continue

        line = INLINE.sub(lambda m: m.group(1) + m.group(2) + rewrite(m.group(3)) + m.group(4) + m.group(5), line)
        ref = REFDEF.match(line)
        if ref:
            line = ref.group(1) + ref.group(2) + rewrite(ref.group(3)) + ref.group(4) + (ref.group(5) or "")
        out.append(line)
    return "\n".join(out)


LIST_ITEM = re.compile(r"^( *)([-*+]|\d+[.)]) ")


def _check_list_syntax(src: str, number: int, previous: str, line: str) -> None:
    """Refuse the two list shapes GitHub renders and MkDocs does not.

    The same file has to look right in both places. GitHub nests a list
    indented by 2 or 3 spaces and starts a list straight after a paragraph;
    Python-Markdown needs 4 spaces and a blank line, and otherwise flattens the
    list or runs it into the paragraph without any warning of its own.
    """
    item = LIST_ITEM.match(line)
    if item is None:
        return
    indent = len(item.group(1))
    if 0 < indent < 4:
        log.warning(
            "%s:%d: nested list indented by %d spaces; use 4 so the site nests it as GitHub does",
            src,
            number,
            indent,
        )
    elif indent == 0 and previous.strip() != "" and LIST_ITEM.match(previous) is None:
        if not previous.startswith((" ", "#", "|", ">")):
            log.warning(
                "%s:%d: list starts straight after a paragraph; add a blank line before it",
                src,
                number,
            )
