import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.ODDS_SERVER_PORT || 4001;

app.use(cors());

const API_KEY = process.env.ODDS_API_KEY;
const REGION = process.env.ODDS_REGION || "us";
const BOOKMAKER = process.env.ODDS_BOOKMAKER || "draftkings";

// Sport keys used below match The Odds API docs for NHL (`icehockey_nhl`) and
// the same v4 odds pattern for other sports. Markets h2h, spreads, totals and
// american odds format are supported by the docs. :contentReference[oaicite:1]{index=1}
const SPORTS = [
  { key: "basketball_ncaab", title: "College Basketball" },
  { key: "baseball_mlb", title: "MLB" },
  { key: "icehockey_nhl", title: "NHL" },
];

function normalizeMarketOutcome(event, bookmaker, marketKey) {
  const market = bookmaker?.markets?.find((m) => m.key === marketKey);
  if (!market?.outcomes?.length) return [];

  if (marketKey === "h2h") {
    return market.outcomes
      .filter((outcome) => outcome.name === event.home_team || outcome.name === event.away_team)
      .map((outcome) => ({
        id: `${event.id}-h2h-${outcome.name}`,
        sport_key: event.sport_key,
        sport_title: event.sport_title,
        commence_time: event.commence_time,
        home_team: event.home_team,
        away_team: event.away_team,
        marketType: "side",
        sidePick: "ml",
        sideNumber: null,
        totalPick: null,
        totalNumber: null,
        odds: outcome.price,
        selectedTeam: outcome.name,
        bookmaker: bookmaker.title,
      }));
  }

  if (marketKey === "spreads") {
    return market.outcomes
      .filter(
        (outcome) =>
          (outcome.name === event.home_team || outcome.name === event.away_team) &&
          typeof outcome.point === "number"
      )
      .map((outcome) => ({
        id: `${event.id}-spread-${outcome.name}-${outcome.point}`,
        sport_key: event.sport_key,
        sport_title: event.sport_title,
        commence_time: event.commence_time,
        home_team: event.home_team,
        away_team: event.away_team,
        marketType: "side",
        sidePick: outcome.point > 0 ? "plus" : "minus",
        sideNumber: Math.abs(outcome.point),
        totalPick: null,
        totalNumber: null,
        odds: outcome.price,
        selectedTeam: outcome.name,
        bookmaker: bookmaker.title,
      }));
  }

  if (marketKey === "totals") {
    return market.outcomes
      .filter(
        (outcome) =>
          (outcome.name === "Over" || outcome.name === "Under") &&
          typeof outcome.point === "number"
      )
      .map((outcome) => ({
        id: `${event.id}-total-${outcome.name}-${outcome.point}`,
        sport_key: event.sport_key,
        sport_title: event.sport_title,
        commence_time: event.commence_time,
        home_team: event.home_team,
        away_team: event.away_team,
        marketType: "total",
        sidePick: null,
        sideNumber: null,
        totalPick: outcome.name.toLowerCase(),
        totalNumber: outcome.point,
        odds: outcome.price,
        selectedTeam: null,
        bookmaker: bookmaker.title,
      }));
  }

  return [];
}

function chooseBookmaker(event) {
  if (!Array.isArray(event.bookmakers) || !event.bookmakers.length) return null;

  const preferred =
    event.bookmakers.find((book) => book.key === BOOKMAKER) ||
    event.bookmakers[0];

  return preferred || null;
}

function flattenEventToLines(event) {
  const bookmaker = chooseBookmaker(event);
  if (!bookmaker) return [];

  return [
    ...normalizeMarketOutcome(event, bookmaker, "h2h"),
    ...normalizeMarketOutcome(event, bookmaker, "spreads"),
    ...normalizeMarketOutcome(event, bookmaker, "totals"),
  ];
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

  return Array.isArray(data)
    ? data.flatMap((event) =>
        flattenEventToLines({
          ...event,
          sport_title: event.sport_title || sport.title,
        })
      )
    : [];
}

app.get("/api/combined-odds", async (_req, res) => {
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

    res.json({
      updatedAt: new Date().toISOString(),
      bookmaker: BOOKMAKER,
      items,
    });
  } catch (error) {
    res.status(500).json({
      error: "Could not load combined odds.",
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Combined odds server running on http://localhost:${PORT}`);
});