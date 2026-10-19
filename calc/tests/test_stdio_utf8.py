"""stdio 编码：中文 Windows（GBK 管道）下产出必须仍是合法 UTF-8。

来源：开源版 Vibe-Research issue #27。本仓库用 `PYTHONIOENCODING=gbk` 实测同样成立 ——
同一个端点，UTF-8 下产出合法 UTF-8，GBK 下产出的字节就不是了，**而两次退出码相同、都不报错**。

🔴 第一条测试是**证明这个坑真实存在**：不先证明「不修就会坏」，后面那条「修完能写出去」
   等于没测 —— 说不定它在任何情况下都能通过。（这条方法论也是上游 #27 回复里写的。）
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]

# 不换行空格：网页抓来的中文里到处都是，GBK 编不出它
NBSP = "\xa0"
PAYLOAD = {"note": f"读法：这是全世界定价{NBSP}不是本公司采购价"}


def _run(code: str, encoding: str | None) -> subprocess.CompletedProcess[bytes]:
    env = {"PATH": "/usr/bin:/bin"}
    if encoding:
        env["PYTHONIOENCODING"] = encoding
    return subprocess.run([sys.executable, "-c", code], capture_output=True, env=env, check=False)


def test_坑真实存在_不重配编码时GBK管道会崩():
    """没有 force_utf8_stdio 时，同样的内容在 GBK 管道下写不出去。"""
    r = _run(f"import json;print(json.dumps({PAYLOAD!r}, ensure_ascii=False))", "gbk")
    assert r.returncode != 0, f"预期崩掉，却成功了：{r.stdout!r}"
    assert b"UnicodeEncodeError" in r.stderr, r.stderr[-300:]


@pytest.mark.parametrize("pkg", ["calc", "backtest"])
def test_重配之后GBK管道也能写出合法UTF8(pkg: str):
    code = (
        f"import sys;sys.path.insert(0,{str(REPO)!r});"
        f"from {pkg}.stdio_utf8 import force_utf8_stdio;force_utf8_stdio();"
        f"import json;print(json.dumps({PAYLOAD!r}, ensure_ascii=False))"
    )
    r = _run(code, "gbk")
    assert r.returncode == 0, r.stderr[-400:]
    # 关键断言不是"没崩"，而是**Node 侧按 UTF-8 读得懂** —— 那才是真正的失败面
    text = r.stdout.decode("utf-8")           # 解不出来就是这条没修好
    assert json.loads(text)["note"].startswith("读法：")


def _body(path: pathlib.Path) -> str:
    """取出 force_utf8_stdio 的函数体，去掉文档串 / 注释 / 空行 —— 只比行为。"""
    src = path.read_text(encoding="utf-8")
    m = re.search(r"^def force_utf8_stdio\(\) -> None:\n((?:(?:    .*)?\n)+)", src, re.M)
    assert m, f"{path} 里没找到 force_utf8_stdio"
    lines = []
    for line in m.group(1).splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith('"""') or s.startswith("'''"):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines)


def test_三份实现的函数体必须逐字相同():
    """三个包互相 import 不到（skill 刻意自包含），只能各放一份 —— 那就钉死它们不许漂移。"""
    paths = [
        REPO / ".agents/skills/data-access/scripts/core/stdio_utf8.py",
        REPO / "calc/stdio_utf8.py",
        REPO / "backtest/stdio_utf8.py",
    ]
    for p in paths:
        assert p.exists(), f"{p} 不在了，这条断言会变成空查"
    bodies = {str(p.relative_to(REPO)): _body(p) for p in paths}
    assert len(set(bodies.values())) == 1, "三份实现漂移了：\n" + "\n---\n".join(f"{k}:\n{v}" for k, v in bodies.items())


def test_每个打JSON的入口都在main首行调过():
    """漏掉任何一个入口，那条路在中文 Windows 上就是坏的 —— 而且不报错。"""
    entries = [
        REPO / ".agents/skills/data-access/scripts/fetch_endpoint.py",
        REPO / "calc/cli.py",
        REPO / "backtest/cli.py",
    ]
    for p in entries:
        src = p.read_text(encoding="utf-8")
        m = re.search(r"^def main\(\)[^\n]*:\n((?:.*\n){0,6})", src, re.M)
        assert m, f"{p} 里没找到 main()"
        assert "force_utf8_stdio()" in m.group(1), f"{p} 的 main() 开头没调 force_utf8_stdio()"


@pytest.mark.parametrize(
    ("argv", "stdin"),
    [
        (["-m", "calc.cli", "peg", "--args", '{"pe":30,"cagr":0.3}'], None),
        (["calc/cli.py", "peg", "--args", '{"pe":30,"cagr":0.3}'], None),
        (["-m", "backtest.cli"], '{"catalog":true}'),
        (["backtest/cli.py"], '{"catalog":true}'),
        ([".agents/skills/data-access/scripts/fetch_endpoint.py", "--help"], None),
    ],
)
def test_两种跑法都要能起来_相对import会只坏一半(argv: list[str], stdin: str | None):
    """`python -m pkg.cli` 与 `python pkg/cli.py` 都得能跑。

    🔴 真踩过：给入口加 import 时写成相对 import（`from .stdio_utf8 import …`），
       `-m` 那条路好好的，**当脚本跑就 ImportError** —— 而 `calc/tests/test_cli.py`
       正是用脚本方式调的，14 条测试当场红。加东西给"两种跑法都支持"的文件时，
       两条路都得真跑一遍，不能只验顺手的那条。
    """
    r = subprocess.run(
        [sys.executable, *argv], cwd=REPO, input=stdin, capture_output=True, text=True, check=False,
    )
    assert "ImportError" not in r.stderr and "ModuleNotFoundError" not in r.stderr, r.stderr[-300:]
    assert r.returncode == 0, f"退出码 {r.returncode}\n{r.stderr[-300:]}"


def test_stdin坏字节必须报错_不许悄悄替换成问号():
    """🔴 进来的字节坏了要**当场报错**。

    `errors="replace"` 会把坏字节变成 `�`，而 JSON **往往仍能解析成功** ——
    于是产品拿着一个被篡改过的标的代码去查数，还照常返回结果。
    这正是「把一个本该报错的情况变成静默出错字」。（Codex 审计 r6 P2）
    """
    # 合法 JSON 骨架 + 一个孤立的 0xE4（截断的中文首字节）
    payload = b'{"catalog":true,"note":"' + b"\xe4" + b'"}'
    r = subprocess.run(
        [sys.executable, "-m", "backtest.cli"], cwd=REPO, input=payload,
        capture_output=True, env={"PATH": "/usr/bin:/bin"}, check=False,
    )
    combined = r.stdout + r.stderr
    assert b"\xef\xbf\xbd" not in combined, "坏字节被悄悄换成了 � 并继续往下走"
    assert r.returncode != 0 or b"refused" in r.stdout or b"error" in r.stdout, \
        f"既没报错也没拒绝：rc={r.returncode} out={r.stdout[:200]!r}"


def test_stdout重配失败必须抛_不许当作已经是UTF8():
    """吞掉它等于「以为防线生效了」，而原来那个坑原样复活、没人知道。"""
    code = (
        f"import sys;sys.path.insert(0,{str(REPO)!r});"
        "import io;"
        # 一个没有 reconfigure 的 stdout：模拟宿主换掉了标准流
        "sys.stdout=io.StringIO();"
        "from calc.stdio_utf8 import force_utf8_stdio;"
        "force_utf8_stdio()"
    )
    r = _run(code, None)
    assert r.returncode != 0, "stdout 不可重配却照常放行了"
    assert b"stdout" in r.stderr, r.stderr[-300:]


def test_stderr不可重配时不拦住进程():
    """stderr 只承载诊断信息 —— 为它拦住整个进程是过度反应。"""
    code = (
        f"import sys;sys.path.insert(0,{str(REPO)!r});"
        "import io;sys.stderr=io.StringIO();"
        "from calc.stdio_utf8 import force_utf8_stdio;force_utf8_stdio();"
        "print('ok')"
    )
    r = _run(code, None)
    assert r.returncode == 0, r.stderr[-300:]
    assert r.stdout.strip() == b"ok"
