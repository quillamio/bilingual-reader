import test from "node:test";
import assert from "node:assert/strict";
import {recordDiagnostic,getDiagnosticReport,clearDiagnostics} from "../src/taskDiagnostics.ts";
test("report whitelist prevents arbitrary secrets and bounds memory",()=>{clearDiagnostics();recordDiagnostic("SECRET_KEY","https://private","manuscript",429,3);const report=getDiagnosticReport();assert.ok(!report.includes("SECRET_KEY")&&!report.includes("https://private")&&!report.includes("manuscript"));assert.ok(report.includes("429"));for(let i=0;i<400;i++)recordDiagnostic("google","request","success");assert.equal(JSON.parse(getDiagnosticReport()).events.length,300);clearDiagnostics();assert.equal(JSON.parse(getDiagnosticReport()).events.length,0);});
