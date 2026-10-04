// The terrain providers' own attribution statements that carry digits (a year, award numbers, a dataset name). The
// credits show each in a data-unit element, and the screen checks accept exactly these strings
// (tests/e2e/harness/checks.ts UNIT_ALLOWLIST), so the exemption cannot hide a number. Which providers fill the
// tiles AfterRain draws: each tile's X-Imagery-Sources header (data/LICENSE-DATA.md, Terrain Tiles).
export const TERRAIN_CREDITS = [
  '© Environment Agency copyright and/or database right 2015. All rights reserved',
  'ArcticDEM: DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736',
  'SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey',
  'ETOPO1: U.S. National Oceanic and Atmospheric Administration',
] as const;
