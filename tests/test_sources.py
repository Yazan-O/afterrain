from pipeline.sources import _samples


def _row(date: str, det: str, result: str) -> dict:
    return {"SampleDate": date, "Determinand": det, "Result": result}


def test_replicate_enterococci_are_not_paired():
    rows = [
        _row("2022-07-12T08:05:00", "E. coli", "200"),
        _row("2022-07-12T08:05:00", "E. coli", "200"),
        _row("2022-07-12T08:05:00", "Enterococci", "100"),
        _row("2022-07-12T08:05:00", "Enterococci", "10"),
        _row("2022-07-13T08:05:00", "E. coli", "3100"),
        _row("2022-07-13T08:05:00", "Enterococci", "900"),
    ]
    got = _samples(rows)
    assert [s.ecoli for s in got] == [200.0, 200.0, 3100.0]
    assert [s.enterococci for s in got] == [None, None, 900.0]
