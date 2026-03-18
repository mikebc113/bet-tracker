export default async function handler(req, res) {
  const apiKey = process.env.ODDS_API_KEY;
  const region = process.env.ODDS_REGION || "us";
  const bookmaker = process.env.ODDS_BOOKMAKER || "draftkings";

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing ODDS_API_KEY in environment variables.",
    });
  }

  try {
    const url =
      "https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds?" +
      new URLSearchParams({
        apiKey,
        regions: region,
        markets: "h2h,spreads,totals",
        bookmakers: bookmaker,
        oddsFormat: "american",
      }).toString();

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load odds.",
      details: String(error),
    });
  }
}