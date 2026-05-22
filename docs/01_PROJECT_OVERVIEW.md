# Přehled projektu

**Status:** Baseline dokumentace

## Účel

SIM systém je samostatná webová aplikace a datový provider pro COM. Generuje syntetická situační data, řídí scénáře, poskytuje fault injection, AI asistované návrhy scénářů a cacheované mapové provider API.

## Hlavní schopnosti

- Generování výhradně syntetických aircraft, UAV, missile-track, friendly-force, rescue a report dat.
- Vlastní UI pro scenario builder, scenario control, fault injection, publisher monitor, konfiguraci a AI Scenario Assistant.
- Publisher vůči aktuálnímu COM/COP ingest API přes Shared Integration Contract v1.
- Provider katalog pro source-neutral COM mapové vrstvy.
- Dry-run režim, mock COP endpoint pro testy a persistent publisher queue.
- OpenAI, Codex, lokální LLM a mock provider přes jednotnou provider abstraction.

## Projektová hranice

COM/COP aplikace se v tomto repozitáři neimplementuje. SIM projekt musí být spustitelný a testovatelný nezávisle, včetně dry-run publikace a contract testů proti mock endpointu.

## Bezpečnostní omezení

Systém nesmí obsahovat targeting, navádění, zbraňové workflow, bojové plánování ani taktické doporučení. Missile tracks jsou pouze syntetické testovací objekty se zjednodušenou trajektorií pro ověření ingestu a vizualizačních downstream toků v COM.
