"""导出每个注册表端点对应 Python 函数的**真实参数名**,供棘轮核对。

🔴 为什么要有它:注册表的 `args` 是"允许传哪些键"的白名单,但键最终是直接
   `fn(**call_args)` 传进去的 —— 名字对不上就 `TypeError`,而错误只落在信封里
   (`status:"failed"`,证据 0 条)。全市场龙虎榜就这么静默失败过:注册表没声明 args,
   页面注入的 `date` 走全局放行键进去,函数其实收的是 `trade_date`。
   **白名单放行 ≠ 函数收得下** —— 只有比对签名能发现这一类。

`module: "legacy"` 的端点是独立脚本不是可导入函数,机制不同,由调用方显式排除。
"""
import importlib
import inspect
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, ".agents", "skills", "data-access", "scripts"))


def main() -> None:
    with open(os.path.join(ROOT, "datasources", "registry.json"), encoding="utf-8") as f:
        reg = json.load(f)
    out = {}
    for e in reg["endpoints"]:
        mod_name = e["module"]
        try:
            mod = importlib.import_module(mod_name if "." in mod_name else f"sources.{mod_name}")
            sig = inspect.signature(getattr(mod, e["function"]))
            out[e["id"]] = {
                "module": mod_name,
                "params": [p.name for p in sig.parameters.values()],
                # 收 **kwargs 的函数什么键都吃得下,核不了也不用核
                "var_kw": any(p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()),
            }
        except Exception as ex:  # noqa: BLE001
            out[e["id"]] = {"module": mod_name, "error": f"{type(ex).__name__}: {ex}"}
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
