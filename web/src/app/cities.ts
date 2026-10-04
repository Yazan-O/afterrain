// OneAquaHealth's five cities: names and centres as city_<id>.json gives them (the centre sets the sun for the
// automatic theme, and marks the city on the story's map of Europe), the zone, and the country the story names.
import type { CityId } from '../data/schemas';

export const CITIES: Record<CityId, { name: string; country: string; lon: number; lat: number; zone: string }> = {
  CO: { name: 'Coimbra', country: 'Portugal', lon: -8.4103, lat: 40.2033, zone: 'Europe/Lisbon' },
  BE: { name: 'Benevento', country: 'Italy', lon: 14.7868, lat: 41.1291, zone: 'Europe/Rome' },
  GH: { name: 'Ghent', country: 'Belgium', lon: 3.7174, lat: 51.0543, zone: 'Europe/Brussels' },
  OS: { name: 'Oslo', country: 'Norway', lon: 10.7522, lat: 59.9139, zone: 'Europe/Oslo' },
  TO: { name: 'Toulouse', country: 'France', lon: 1.4442, lat: 43.6047, zone: 'Europe/Paris' },
};
export const CITY_ORDER: CityId[] = ['CO', 'BE', 'GH', 'OS', 'TO'];
