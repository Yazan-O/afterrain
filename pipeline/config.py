"""Paths, source URLs, licences and fixed study constants."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
RESTRICTED = RAW / "restricted"
OUT = ROOT / "data" / "out"

CC_BY_4 = "CC BY 4.0"
OGL_3 = "Open Government Licence v3.0"
ODBL = "ODbL 1.0 (OpenStreetMap contributors)"
OPEN_METEO = "CC BY 4.0 (Open-Meteo.com)"
OAH_API = "OneAquaHealth public API, read-only; terms not stated (not redistributed beyond derived app files)"
UNCLEAR = "licence not stated; kept out of the published dataset"

USER_AGENT = "sayr-pipeline/0.1 (open-data research)"

# Wessex Water open data (ArcGIS FeatureServer layers, CC BY 4.0, times in UTC).
ARCGIS = "https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/"
EDM_LAYERS = {
    "2020_2023": ARCGIS + "Wessex_Water_Event_Duration_Monitoring_2020_23_view/FeatureServer/0",
    "2024": ARCGIS + "Wessex_Water_Event_Duration_Monitoring_2024_view/FeatureServer/0",
    "2025": ARCGIS + "Wessex_Water_Event_Duration_Monitoring_2025_view/FeatureServer/0",
    "2026": ARCGIS + "Wessex_Water_Event_Duration_Monitoring_2026_view2/FeatureServer/0",
}
WQ_LAYER = ARCGIS + "Wessex_Water_Environmental_Water_Quality_view/FeatureServer/0"

# Warleigh Weir, River Avon near Bath.
WARLEIGH = (51.37705, -2.300635)
WARLEIGH_SAMPLE_BOX = "Latitude>51.3765 AND Latitude<51.3775 AND Longitude>-2.3011 AND Longitude<-2.3001"
# Upstream overflows: the 27 site ids of the 2020-2024 layers, and the box that holds the same
# overflows under their new 2025 ids.
WARLEIGH_UPSTREAM_IDS = [
    "13130S", "17390C", "14452B", "13031S", "16897C", "16898C", "16899C", "16925C", "16922C",
    "13352S", "16790C", "16789C", "14531S", "16788C", "13331C", "15536B", "13226S", "13341S",
    "13256S", "16546C", "14459B", "14444B", "19556S", "16900C", "13318B", "16935C", "12772C",
]
WARLEIGH_UPSTREAM_BOX = ("OutfallLatitude>51.28 AND OutfallLatitude<51.378 "
                         "AND OutfallLongitude>-2.35 AND OutfallLongitude<-2.20")
NEAR_FIELD = ["FRESHFORD STORM TANK", "FRESHFORD FIELDS", "WINSLEY STORM TANK", "BRADFORD-ON-AVON",
              "MONKTON COMBE", "MIDFORD", "FRESHFORD NEW INN", "SAINT ALDHELMS", "WESTWOOD STORM TANK"]
FRESHFORD = "FRESHFORD STORM TANK"

# Farleigh Hungerford bathing water, River Frome.
FARLEIGH = (51.3093, -2.2861)
FARLEIGH_SAMPLE_BOX = "Latitude>51.3088 AND Latitude<51.3098 AND Longitude>-2.2866 AND Longitude<-2.2856"
FARLEIGH_UPSTREAM_BOX = ("OutfallLatitude>51.15 AND OutfallLatitude<51.312 "
                         "AND OutfallLongitude>-2.45 AND OutfallLongitude<-2.24")
FARLEIGH_EXCLUDE = ("SOUTHWICK", "WINGFIELD", "NORTH BRADLEY", "TROWBRIDGE", "WELLOW", "MIDFORD", "MONKTON")

# Environment Agency hydrology (OGL v3), daily values.
EA_HYDROLOGY = "https://environment.data.gov.uk/hydrology/id/measures/"
RAIN_CLAVERTON = "c4cceecc-19e7-471d-b57a-d04d88db1da6-rainfall-t-86400-mm-qualified"
FLOW_BRADFORD = "585e49e0-7070-4d85-9c52-ccd18a5a1e65-flow-m-86400-m3s-qualified"
FLOW_TELLISFORD = "29434d59-1597-4783-b0b6-9f9a821d30d8-flow-m-86400-m3s-qualified"
HYDRO_START, HYDRO_END = "2021-01-01", "2026-01-01"

# Alewife Brook, Massachusetts (licences not stated: cached under data/raw/restricted, never published).
MWRA_CSO_CSV = "https://www.mwra.com/our-environment/combined-sewer-overflow-cso-notifications/cso-table-export"
MWRA_MYSTIC_XLSX = "https://www.mwra.com/media/file/mystic-river-bacteria-data"
MASSDEP_ALEWIFE_XLSX = ("https://eeaonline.eea.state.ma.us/dep/CSOAPI/api/Incident/GetIncidentsForExcel/"
                        "?WaterBody=Alewife%20Brook&")

# OneAquaHealth public API (the Resilience Map backend), read-only.
OAH_BASE = "https://api.enora-oah.eu/api"
OAH_HEADERS = {"Accept": "application/json", "Origin": "https://apps.oneaquahealth.eu",
               "Referer": "https://apps.oneaquahealth.eu/resmap/"}
OAH_CITIES = ["BE", "CO", "GH", "OS", "TO"]

OVERPASS = "https://overpass-api.de/api/interpreter"
OPEN_METEO_ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble"
ENSEMBLE_MODEL = "ecmwf_ifs025"

THRESHOLD = 900.0  # E. coli per 100 ml, used as a single-sample flag


def label(value: float, qualifier: str = "") -> bool | None:
    """Over THRESHOLD (True), at or under it (False), or None when the laboratory qualifier leaves it undecided:
    "<1000" can lie on either side of 900, "<900" cannot be over it, ">10000" is over it, ">500" is undecided."""
    if qualifier == "":
        return value > THRESHOLD
    if qualifier == "<":
        return False if value <= THRESHOLD else None
    if qualifier == ">":
        return True if value >= THRESHOLD else None
    raise ValueError(f"unknown laboratory qualifier {qualifier!r}")


WINDOW_H = 48.0
# Hours from taking a quest sample to its E. coli result: culture methods incubate about 18-24 h (ISO 9308-2
# Colilert-18 reads at 18-22 h), so a result reaches Sayr the next day. Only hours from then on count toward a quest.
LAB_TURNAROUND_H = 24
