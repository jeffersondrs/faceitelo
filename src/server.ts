import express, { Request, Response } from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FACEIT_KEY = process.env.FACEIT_KEY || "";
const DEBUG_FACEIT = process.env.DEBUG_FACEIT === "true";

type GameData = {
  name?: string;
  game_id?: string;
  slug?: string;
  skill_level?: number;
  faceit_elo?: number;
  [key: string]: any;
};

type CacheEntry = {
  value: any;
  expire: number;
};

const cache = new Map<string, CacheEntry>();
function setCache(key: string, value: any, ttl = 30_000) {
  cache.set(key, { value, expire: Date.now() + ttl });
}
function getCache(key: string) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

app.get("/faceit/:nick", async (req: Request, res: Response) => {
  const nick = req.params.nick;
  const game = (req.query.game as string)?.toLowerCase() || "cs2";
  const fmt = (req.query.format as string)?.toLowerCase() || "json";

  if (!FACEIT_KEY) {
    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("FACEIT_KEY não configurada");
    }
    return res.status(500).json({ error: "FACEIT_KEY não configurada" });
  }

  const cacheKey = `faceit:${nick}:${game}`;
  const cached = getCache(cacheKey);
  if (cached) {
    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(cached.text);
    }
    return res.json(cached.json);
  }

  try {
    const apiUrl = "https://open.faceit.com/data/v4/players";
    const response = await axios.get(apiUrl, {
      params: { nickname: nick, game },
      headers: { Authorization: `Bearer ${FACEIT_KEY}` },
      timeout: 1500,
    });

    const data = response.data;
    if (DEBUG_FACEIT) console.log(JSON.stringify(data, null, 2));

    let gamesArray: GameData[] = [];
    if (Array.isArray(data.games)) {
      gamesArray = data.games;
    } else if (data.games && typeof data.games === "object") {
      gamesArray = Object.values(data.games);
    } else if (data.game && typeof data.game === "object") {
      gamesArray = [data.game];
    }

    const gameLower = game.toLowerCase();
    const gameObj = gamesArray.find((g) => {
      if (!g) return false;
      const name = (g.name || g.slug || "").toLowerCase();
      return (
        name.includes(gameLower) ||
        (g.game_id && g.game_id.toLowerCase().includes(gameLower))
      );
    });

    const level =
      (gameObj?.skill_level ??
        data.skill_level ??
        data.games?.[gameLower]?.skill_level) ||
      null;

    const elo =
      (gameObj?.faceit_elo ??
        data.faceit_elo ??
        data.games?.[gameLower]?.faceit_elo) ||
      null;

    const result = {
      nickname: data.nickname || nick,
      player_id: data.player_id,
      game,
      level: level ? String(level) : null,
      elo: elo ?? null,
      retrieved_at: new Date().toISOString(),
    };

    const text =
      result.elo && result.level
        ? `${result.nickname} — ELO: ${result.elo} | Level: ${result.level}`
        : result.level
        ? `${result.nickname} — Level: ${result.level} (ELO não disponível)`
        : `Perfil ${nick} não encontrado ou sem dados para ${game}.`;

    setCache(cacheKey, { json: result, text }, 30_000);

    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(text);
    }
    return res.json(result);
  } catch (err: any) {
    console.error(
      "FACEIT fetch error:",
      err.response?.status || err.code || err.message
    );

    const msg =
      err.response?.status === 404
        ? "Player não encontrado"
        : err.response?.status === 401
        ? "API key inválida"
        : err.response?.status === 429
        ? "Rate limit da FACEIT (429)"
        : err.code === "ECONNABORTED"
        ? "Timeout ao consultar FACEIT"
        : "Erro ao consultar FACEIT";

    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");

      return res.status(200).send(`Erro ao buscar ELO — ${msg}`);
    }

    return res.status(500).json({ error: msg });
  }
});

app.get("/_botrix-test", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`🚀 Faceit API rodando na porta ${PORT}`);
});
