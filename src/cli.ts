#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

const program = new Command().name("clockout").description(pkg.description).version(pkg.version);

program.parse();
