// ============================================================
// GCR SERVICE AREA — the Gulf coastline
// ============================================================
//
// Gulf Coast Radar covers the coast, not a region. A business belongs on GCR
// if it sits within SERVICE_AREA_MILES of the shoreline between New Orleans
// and Mexico Beach; anything further inland is a CyberCheck customer with a
// dashboard, and simply is not a Gulf Coast beach listing.
//
// ── Why a coastline and not a radius ────────────────────────────────────
//
// Panama City is 115 miles from Orange Beach. A circle wide enough to reach it
// reaches just as far north — pulling in Montgomery, Dothan and half of inland
// Alabama. The coast is a line, so the service area is a strip drawn along it.
//
// ── Why a point list and not a polygon ──────────────────────────────────
//
// Distance to the nearest of ~22 anchor points approximates distance to the
// shoreline closely enough at this scale, needs no geo extension in Postgres,
// and is readable: adding a town is one line, and anyone can see what is
// covered. A real coastline polygon would be more precise and far harder to
// reason about or change.
//
// Adding a stretch of coast — further west into Texas, further east toward
// Tampa — means adding anchors here. Nothing else changes.

/** Anchors along the shoreline, west to east. Roughly one per coastal town. */
const COASTLINE = [
    ['New Orleans, LA', 29.95, -90.07],
    ['Slidell, LA', 30.28, -89.78],
    ['Bay St. Louis, MS', 30.31, -89.33],
    ['Gulfport, MS', 30.37, -89.09],
    ['Biloxi, MS', 30.40, -88.89],
    ['Pascagoula, MS', 30.37, -88.56],
    ['Dauphin Island, AL', 30.25, -88.11],
    ['Mobile, AL', 30.69, -88.04],
    ['Fairhope, AL', 30.52, -87.90],
    ['Gulf Shores, AL', 30.25, -87.70],
    ['Orange Beach, AL', 30.27, -87.58],
    ['Perdido Key, FL', 30.29, -87.44],
    ['Pensacola, FL', 30.42, -87.22],
    ['Pensacola Beach, FL', 30.33, -87.14],
    ['Navarre, FL', 30.39, -86.87],
    ['Fort Walton Beach, FL', 30.42, -86.62],
    ['Destin, FL', 30.39, -86.50],
    ['Miramar Beach, FL', 30.38, -86.37],
    ['Santa Rosa Beach, FL', 30.33, -86.17],
    ['Panama City Beach, FL', 30.18, -85.81],
    ['Panama City, FL', 30.16, -85.66],
    ['Mexico Beach, FL', 29.94, -85.42],
];

/** How far inland the strip reaches. */
const SERVICE_AREA_MILES = Number(process.env.GCR_SERVICE_AREA_MILES || 25);

const EARTH_MILES = 3959;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle miles between two points. */
function distanceMiles(lat1, lng1, lat2, lng2) {
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Miles from the shoreline, and the town it is nearest to.
 * Returns null when there are no usable coordinates — "unknown", not "far".
 */
function distanceToCoast(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null; // null island, not a location

    let best = Infinity;
    let nearest = null;
    for (const [name, cLat, cLng] of COASTLINE) {
        const miles = distanceMiles(lat, lng, cLat, cLng);
        if (miles < best) {
            best = miles;
            nearest = name;
        }
    }
    return { miles: Math.round(best * 10) / 10, nearest };
}

/** Coastal towns, for deciding a business that has a city but no coordinates. */
const COASTAL_CITIES = new Set(
    [
        ...COASTLINE.map(([label]) => label.split(',')[0]),
        // Towns inside the strip that are not themselves anchors.
        'Foley', 'Elberta', 'Lillian', 'Magnolia Springs', 'Summerdale', 'Robertsdale',
        'Daphne', 'Spanish Fort', 'Bon Secour', 'Josephine', 'Perdido Beach',
        'Gulf Breeze', 'Milton', 'Pace', 'Cantonment', 'Century', 'Molino',
        'Fort Morgan', 'Point Clear', 'Theodore', 'Bayou La Batre', 'Grand Bay',
        'Ocean Springs', 'Long Beach', 'Pass Christian', 'Waveland', 'Diamondhead',
        'Mary Esther', 'Shalimar', 'Niceville', 'Valparaiso', 'Freeport',
        'Seaside', 'Seagrove Beach', 'Inlet Beach', 'Rosemary Beach', 'Watersound',
        'Grayton Beach', 'Blue Mountain Beach', 'Dune Allen', 'Lynn Haven',
        'Callaway', 'Parker', 'Springfield', 'Metairie', 'Kenner', 'Chalmette',
    ].map((c) => c.toLowerCase())
);

/**
 * Should this business be on GCR?
 *
 * Three outcomes, and the third matters as much as the other two:
 *
 *   { inArea: true  }   coordinates put it inside the strip, or its city is a
 *                       known coastal town
 *   { inArea: false }   coordinates put it outside
 *   { inArea: null  }   no usable location. NOT a decision — the caller must
 *                       not delist on this. 378 live listings have no location
 *                       at all, and a geographic rule that treats "unknown" as
 *                       "outside" would quietly drop every one of them.
 */
function isInServiceArea({ latitude, longitude, city } = {}) {
    const coast = distanceToCoast(latitude, longitude);
    if (coast) {
        return {
            inArea: coast.miles <= SERVICE_AREA_MILES,
            miles: coast.miles,
            nearest: coast.nearest,
            basis: 'coordinates',
        };
    }

    const town = String(city || '').trim().toLowerCase();
    if (town && COASTAL_CITIES.has(town)) {
        return { inArea: true, miles: null, nearest: city, basis: 'city' };
    }

    return { inArea: null, miles: null, nearest: null, basis: 'unknown' };
}

module.exports = {
    COASTLINE,
    COASTAL_CITIES,
    SERVICE_AREA_MILES,
    distanceMiles,
    distanceToCoast,
    isInServiceArea,
};
