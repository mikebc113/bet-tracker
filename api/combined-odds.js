const API_KEY = process.env.ODDS_API_KEY;
const REGION = process.env.ODDS_REGION || "us";
const BOOKMAKER = process.env.ODDS_BOOKMAKER || "draftkings";

// ✅ ONLY COLLEGE BASKETBALL
const SPORTS = [
  {
    key: "basketball_ncaab",
    title: "College Basketball",
  },
];

function chooseBookmaker(event) {
  if (!Array.isArray(event.bookmakers) || !event.bookmakers.length) return null;

  return event.bookmakers.find((book) => book.key === BOOKMAKER) || event.bookmakers[0];
}

function getMarket(bookmaker, key) {
  return bookmaker?.markets?.find((m) => m.key === key) || null;
}

function getOutcomeByName(market, name) {
  return market?.outcomes?.find((o) => o.name === name) || null;
}

function getTotalOutcome(market, label) {
  return market?.outcomes?.find((o) => o.name === label) || null;
}

function mapEventToBoardGame(event, fallbackSportTitle) {
  const bookmaker = chooseBookmaker(event);
  if (!bookmaker) return null;

  const h2h = getMarket(bookmaker, "h2h");
  const spreads = getMarket(bookmaker, "spreads");
  const totals = getMarket(bookmaker, "totals");

  const homeMl = getOutcomeByName(h2h, event.home_team)?.price ?? null;
  const awayMl = getOutcomeByName(h2h, event.away_team)?.price ?? null;

  const homeSpread = getOutcomeByName(spreads, event.home_team);
  const awaySpread = getOutcomeByName(spreads, event.away_team);

  const over = getTotalOutcome(totals, "Over");
  const under = getTotalOutcome(totals, "Under");

  return {
    id: event.id,
    sport_key: event.sport_key,
    sport_title: event.sport_title || fallbackSportTitle,
    commence_time: event.commence_time,
    home_team: event.home_team,
    away_team: event.away_team,
    home_logo: "",
    away_logo: "",
    bookmakers: [
      {
        key: bookmaker.key,
        title: bookmaker.title,
        markets: [
          {
            key: "h2h",
            outcomes: [
              ...(homeMl != null ? [{ name: event.home_team, price: homeMl }] : []),
              ...(awayMl != null ? [{ name: event.away_team, price: awayMl }] : []),
            ],
          },
          {
            key: "spreads",
            outcomes: [
              ...(homeSpread
                ? [{ name: event.home_team, point: homeSpread.point, price: homeSpread.price }]
                : []),
              ...(awaySpread
                ? [{ name: event.away_team, point: awaySpread.point, price: awaySpread.price }]
                : []),
            ],
          },
          {
            key: "totals",
            outcomes: [
              ...(over ? [{ name: "Over", point: over.point, price: over.price }] : []),
              ...(under ? [{ name: "Under", point: under.point, price: under.price }] : []),
            ],
          },
        ],
      },
    ],
  };
}

async function fetchSportOdds(sport) {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`);
  url.searchParams.set("apiKey", API_KEY);
  url.searchParams.set("regions", REGION);
  url.searchParams.set("markets", "h2h,spreads,totals");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("bookmakers", BOOKMAKER);

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed for ${sport.key}: ${response.status} ${text}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) return [];

  return data
    .map((event) => mapEventToBoardGame(event, sport.title))
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: "Missing ODDS_API_KEY in environment variables.",
    });
  }

  try {
    const results = await Promise.all(SPORTS.map(fetchSportOdds));

    const items = results
      .flat()
      .sort(
        (a, b) =>
          new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime()
      );

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      bookmaker: BOOKMAKER,
      items,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Could not load combined odds.",
      details: error.message,
    });
  }
}