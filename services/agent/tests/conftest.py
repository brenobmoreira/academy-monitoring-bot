import pytest

from .fakes import FakeSheet


@pytest.fixture
def sheet() -> FakeSheet:
    return FakeSheet()
