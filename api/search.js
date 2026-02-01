export default async function handler(req, res) {
    try {
      const q = (req.query.q || "").toString().trim();
      if (!q) return res.status(400).json({ error: "Missing query parameter: q" });
  
      const apiKey = process.env.SERPAPI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({
          error: "Missing SERPAPI_API_KEY env var.",
          fix: "Vercel Project → Settings → Environment Variables → add SERPAPI_API_KEY, then Redeploy."
        });
      }
  
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine", "google_shopping");
      url.searchParams.set("q", q);
      url.searchParams.set("hl", "en");
      url.searchParams.set("gl", "us");
      url.searchParams.set("num", "40");
      url.searchParams.set("api_key", apiKey);
  
      const r = await fetch(url.toString());
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).json({ error: "SerpAPI request failed", detail: t.slice(0, 600) });
      }
  
      const data = await r.json();
  
      const items = (data.shopping_results || []).slice(0, 40).map((x) => ({
        title: x.title || "Untitled",
        source: x.source || null,
        link: x.link || null,
        thumbnail: x.thumbnail || null,
        price: typeof x.extracted_price === "number" ? x.extracted_price : null,
        priceText: x.price || null,
        rating: typeof x.rating === "number" ? x.rating : null,
        reviews: typeof x.reviews === "number" ? x.reviews : null,
        delivery: x.delivery || null
      }));
  
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json({ items });
    } catch (e) {
      return res.status(500).json({ error: "Server error", detail: String(e) });
    }
  }
  