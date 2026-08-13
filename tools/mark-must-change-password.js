#!/usr/bin/env node

const dotenv = require("dotenv");

dotenv.config({ quiet: true });

function usage() {
  console.log(`Uso:
  node tools/mark-must-change-password.js --include <UUID> [--include <UUID> ...]
      [--exclude <UUID> ...] [--apply]

O modo padrão é dry-run. Somente --apply altera os usuários selecionados.`);
}

function parseArguments(argv) {
  const parsed = { include: [], exclude: [], apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--include" || argument === "--exclude") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} exige um UUID`);
      }
      parsed[argument.slice(2)].push(value);
      index += 1;
      continue;
    }
    throw new Error(`Argumento desconhecido: ${argument}`);
  }
  return parsed;
}

function validateUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 1;
}

if (!process.exitCode && options.help) {
  usage();
} else if (!process.exitCode) {
  if (!options.include.length) {
    console.error("Informe ao menos um UUID com --include.");
    usage();
    process.exitCode = 1;
  }

  const invalid = [...options.include, ...options.exclude].filter((id) => !validateUuid(id));
  if (!process.exitCode && invalid.length) {
    console.error(`UUID inválido: ${invalid.join(", ")}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode && !options.help) {
  const db = require("../src/db");
  try {
    const results = db.markUsersMustChangePassword({
      userIds: options.include,
      excludeUserIds: options.exclude,
      apply: options.apply,
    });
    console.log(`Banco: ${db.databasePath}`);
    console.log(`Modo: ${options.apply ? "APPLY" : "DRY-RUN"}`);
    console.table(results.map((result) => ({
      id: result.id,
      name: result.name || "-",
      email: result.email || "-",
      active: result.active === undefined ? "-" : result.active,
      roles: result.operationalRoles?.join(", ") || "-",
      status: result.status,
    })));
    if (!options.apply) {
      console.log("Nenhum usuário foi alterado. Revise a lista e acrescente --apply somente após a validação.");
    }
    if (results.some((result) => result.status === "not_found")) process.exitCode = 2;
  } finally {
    db.closeDatabase();
  }
}
