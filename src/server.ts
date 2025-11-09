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
    // 1) Busca dados básicos do jogador
    const apiUrl = "https://open.faceit.com/data/v4/players";
    const playerResp = await axios.get(apiUrl, {
      params: { nickname: nick, game },
      headers: { Authorization: `Bearer ${FACEIT_KEY}` },
      timeout: 1500, // curto para evitar timeout no BotRix
    });

    const data = playerResp.data;
    if (DEBUG_FACEIT)
      console.log("player data:", JSON.stringify(data, null, 2));

    // Normaliza games (array/obj)
    let gamesArray: GameData[] = [];
    if (Array.isArray(data.games)) {
      gamesArray = data.games;
    } else if (data.games && typeof data.games === "object") {
      gamesArray = Object.values(data.games);
    } else if (data.game && typeof data.game === "object") {
      gamesArray = [data.game];
    }

    const gameLower = game.toLowerCase();
    const gameObj =
      gamesArray.find((g) => {
        if (!g) return false;
        const name = (g.name || g.slug || "").toString().toLowerCase();
        return (
          name.includes(gameLower) ||
          (g.game_id && g.game_id.toString().toLowerCase().includes(gameLower))
        );
      }) || null;

    const level =
      gameObj?.skill_level ??
      data.skill_level ??
      (data.games && data.games[gameLower]?.skill_level) ??
      null;
    const elo =
      gameObj?.faceit_elo ??
      data.faceit_elo ??
      (data.games && data.games[gameLower]?.faceit_elo) ??
      null;

    const playerId = data.player_id || data.playerId || null;
    const playerNickname = data.nickname || nick;

    // Prepara resultado básico
    const baseResult: any = {
      nickname: playerNickname,
      player_id: playerId,
      game,
      level: level ? String(level) : null,
      elo: elo ?? null,
      retrieved_at: new Date().toISOString(),
      // serão preenchidos abaixo
      matches_today: 0,
      wins_today: 0,
      losses_today: 0,
      total_matches: 0,
    };

    // 2) Tenta buscar histórico de partidas (se tivermos player_id)
    let historyItems: any[] = [];
    if (playerId) {
      try {
        const histUrl = `https://open.faceit.com/data/v4/players/${playerId}/history`;
        const histResp = await axios.get(histUrl, {
          params: { game, limit: 50 }, // pega até 50 partidas recentes
          headers: { Authorization: `Bearer ${FACEIT_KEY}` },
          timeout: 1500, // curto
        });

        const histData = histResp.data;
        if (DEBUG_FACEIT)
          console.log("history data:", JSON.stringify(histData, null, 2));

        historyItems = Array.isArray(histData.items)
          ? histData.items
          : histData?.items ?? [];
        baseResult.total_matches =
          typeof histData.total === "number"
            ? histData.total
            : historyItems.length;
      } catch (errHist: any) {
        if (DEBUG_FACEIT)
          console.warn("history fetch failed:", errHist?.message || errHist);
        // keep historyItems empty -> retornaremos 0 para hoje
        baseResult.total_matches = 0;
      }
    }

    // 3) Analisa matches do dia (usando started_at timestamp em segundos)
    if (historyItems.length > 0) {
      // início do dia local (00:00:00) — usa timezone do servidor
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTs = todayStart.getTime();

      let wins = 0;
      let losses = 0;
      let played = 0;

      for (const m of historyItems) {
        // some items may have started_at (seconds since epoch)
        const startedAtSec = m.started_at ?? m.startedAt ?? null;
        if (!startedAtSec) continue;
        const startedAt = new Date(startedAtSec * 1000).getTime();
        if (startedAt < todayTs) continue; // não é de hoje

        // identifica se o jogador estava em faction1 ou faction2
        let playerFaction: string | null = null;
        try {
          if (m.teams) {
            // padrão: teams.faction1.players[] ou teams.faction1.player_ids
            if (m.teams.faction1) {
              const f1 = m.teams.faction1;
              const f1Players = Array.isArray(f1.players)
                ? f1.players
                : f1.player_ids ?? [];
              if (
                f1Players.some((p: any) =>
                  p.player_id
                    ? p.player_id === playerId
                    : p === playerId || p.nickname === playerNickname
                )
              ) {
                playerFaction = "faction1";
              }
            }
            if (!playerFaction && m.teams.faction2) {
              const f2 = m.teams.faction2;
              const f2Players = Array.isArray(f2.players)
                ? f2.players
                : f2.player_ids ?? [];
              if (
                f2Players.some((p: any) =>
                  p.player_id
                    ? p.player_id === playerId
                    : p === playerId || p.nickname === playerNickname
                )
              ) {
                playerFaction = "faction2";
              }
            }
          }
        } catch {
          /* ignore parsing errors per match */
        }

        // determina vencedor (p.ex. result.winner === "faction1" || "faction2")
        const winner = m.results?.winner ?? m.results?.winner_team ?? null;

        // conta partidas jogadas hoje
        played++;

        if (winner && playerFaction) {
          if (winner === playerFaction) wins++;
          else losses++;
        } else {
          // se não souber o vencedor ou a facção, não conta como win/loss
        }
      }

      baseResult.matches_today = played;
      baseResult.wins_today = wins;
      baseResult.losses_today = losses;
    } else {
      // sem histórico: já temos zeroes, mas mantém total_matches (0 ou setado)
    }

    // 4) Monta texto para chat (versão enxuta)
    const chatText =
      baseResult.elo && baseResult.level
        ? `${baseResult.nickname} — ELO: ${baseResult.elo} | Level: ${baseResult.level} | Hoje: ${baseResult.wins_today}W ${baseResult.losses_today}L (${baseResult.matches_today} partidas) | Total: ${baseResult.total_matches}`
        : baseResult.level
        ? `${baseResult.nickname} — Level: ${baseResult.level} | Hoje: ${baseResult.wins_today}W ${baseResult.losses_today}L (${baseResult.matches_today} partidas) | Total: ${baseResult.total_matches}`
        : `Perfil ${nick} não encontrado ou sem dados para ${game}.`;

    // 5) Cache e resposta
    setCache(cacheKey, { json: baseResult, text: chatText }, 60_000); // cache 60s

    if (fmt === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(chatText);
    }
    return res.json(baseResult);
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
