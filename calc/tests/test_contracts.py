import inspect

from calc.cli import FUNCTIONS
from calc.contracts import ARG_KINDS, validate_contract


def test_contract_registry_matches_every_real_function_signature():
    assert set(ARG_KINDS) == set(FUNCTIONS)
    for name, fn in FUNCTIONS.items():
        assert set(ARG_KINDS[name]) == set(inspect.signature(fn).parameters), name


def test_validate_contract_checks_signature_and_json_types_without_running_formula():
    assert validate_contract("forward_pe", {"price": 100, "eps_forecast": 5}, FUNCTIONS) is None
    assert "eps_forecast" in validate_contract("forward_pe", {"price": 100}, FUNCTIONS)
    assert "price" in validate_contract("forward_pe", {"price": "abc", "eps_forecast": 5}, FUNCTIONS)
    assert "number" in validate_contract("forward_pe", {"price": True, "eps_forecast": 5}, FUNCTIONS)
    assert "unexpected" in validate_contract("forward_pe", {"price": 100, "eps_forecast": 5, "extra": 1}, FUNCTIONS)
    assert "未知函数" in validate_contract("missing", {}, FUNCTIONS)
