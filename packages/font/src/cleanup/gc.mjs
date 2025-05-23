import * as Geometry from "@iosevka/geometry";
import { Transform } from "@iosevka/geometry/transform";
import { VS01 } from "@iosevka/glyph/relation";

/// This function will remove all the glyphs outside the subset filter, and all the lookups that are
/// unreachable or emptied by the subsetting process.
///
/// Note that, given the process, glyph markin and lookup marking are entangled. Thus we perform
/// a looped marking process.
export function gcFont(glyphStore, subsetFilter, otl) {
	let markedGlyphNames = createGlyphDepthMapForAllGlyphs(glyphStore);
	let sizeBefore = markedGlyphNames.size;
	let sizeAfter = sizeBefore;

	// Set of accessible and directly accessible lookups
	let aGsub = new Set(),
		daGsub = new Set();
	let aGpos = new Set(),
		daGpos = new Set();

	do {
		sizeBefore = sizeAfter;
		[aGsub, daGsub] = markLookups(otl.GSUB, markedGlyphNames);
		[aGpos, daGpos] = markLookups(otl.GPOS, markedGlyphNames);
		markedGlyphNames = markGlyphs(glyphStore, subsetFilter, otl, daGsub);
		sizeAfter = markedGlyphNames.size;
	} while (sizeAfter < sizeBefore);

	analyzeReferenceGraph(glyphStore, markedGlyphNames);
	sweepOtlTable(otl.GSUB, aGsub);
	sweepOtlTable(otl.GPOS, aGpos);
	return sweepGlyphs(glyphStore, markedGlyphNames);
}

function createGlyphDepthMapForAllGlyphs(glyphStore) {
	let map = new Map();
	for (const [gName, g] of glyphStore.namedEntries()) map.set(gName, 1);
	return map;
}

///////////////////////////////////////////////////////////////////////////////////////////////////

/// This function will mark all the lookups that are reachable and non-empty from the marked glyphs.
/// It will also mark the lookups that are directly reachable from the features.
function markLookups(table, markedGlyphs) {
	if (!table || !table.features) return;

	const reachableLookups = new Set();
	const directReachableLookups = new Set();
	markLookupsStart(table, markedGlyphs, reachableLookups, directReachableLookups);

	let sizeBefore = reachableLookups.size,
		sizeAfter = sizeBefore;

	do {
		sizeBefore = sizeAfter;
		for (const l of Array.from(reachableLookups)) {
			markLookupIndirect(table, l, markedGlyphs, reachableLookups);
		}
		sizeAfter = reachableLookups.size;
	} while (sizeAfter > sizeBefore);

	return [reachableLookups, directReachableLookups];
}

function markLookupsStart(table, markedGlyphs, sink, sinkDirect) {
	for (let f in table.features) {
		const feature = table.features[f];
		if (!feature) continue;
		for (const l of feature.lookups) {
			if (isLookupEmpty(table, l, markedGlyphs)) continue;
			sink.add(l);
			sinkDirect.add(l);
		}
	}
}
function markLookupIndirect(gsub, lid, markedGlyphs, reachableLookups) {
	const lookup = gsub.lookups[lid];
	if (!lookup) return;

	if (lookup.type !== "gsub_chaining" && lookup.type != "gpos_chaining") return;
	for (const rule of lookup.rules) {
		if (!rule || !rule.apply) continue;
		for (const app of rule.apply) {
			if (!app.lookup.name) throw new Error("Unreachable: lookup name should be present");
			if (isLookupEmpty(gsub, app.lookup.name, markedGlyphs)) continue;
			reachableLookups.add(app.lookup.name);
		}
	}
}

function isLookupEmpty(gsub, lid, markedGlyphs) {
	const lookup = gsub.lookups[lid];
	if (!lookup) return true;

	const handler = LookupTypehHanlderMap[lookup.type];
	if (!handler) return false;

	return handler.isEmpty(gsub, lookup, markedGlyphs);
}

function sweepOtlTable(table, accessibleLookupsIds) {
	if (!table || !table.features || !table.lookups) return;
	sweepLookups(table, accessibleLookupsIds);
	sweepFeatures(table, accessibleLookupsIds);
}
function sweepLookups(table, accessibleLookupsIds) {
	let lookups1 = {};
	for (const l in table.lookups) {
		if (accessibleLookupsIds.has(l)) lookups1[l] = table.lookups[l];
	}
	table.lookups = lookups1;
	return accessibleLookupsIds;
}
function sweepFeatures(table, accessibleLookupsIds) {
	let features1 = {};
	for (let f in table.features) {
		const feature = table.features[f];
		if (!feature) continue;
		const featureFiltered = {
			name: feature.name,
			tag: feature.tag,
			lookups: [],
		};
		for (const l of feature.lookups) {
			if (accessibleLookupsIds.has(l)) featureFiltered.lookups.push(l);
		}
		if (!featureFiltered.lookups.length) continue;
		features1[f] = featureFiltered;
	}
	table.features = features1;
}

///////////////////////////////////////////////////////////////////////////////////////////////////

function markGlyphs(glyphStore, subsetFilter, otl, daGsub) {
	const markedGlyphs = markGlyphsInitial(glyphStore, subsetFilter);
	while (markGlyphsGr(glyphStore, markedGlyphs, otl));
	if (otl.GSUB) markGlyphsByGsub(otl.GSUB, markedGlyphs, daGsub);
	while (markGlyphsGr(glyphStore, markedGlyphs, otl));
	return markedGlyphs;
}

function markSingleGlyph(markedGlyphs, gName, d) {
	let existing = markedGlyphs.get(gName);
	if (!existing || d < existing) markedGlyphs.set(gName, d);
}

function markGlyphsInitial(glyphStore, subsetFilter) {
	let markedGlyphs = new Map();
	for (const [gName, g] of glyphStore.namedEntries()) {
		if (!g) continue;
		if (g.glyphRank > 0) markSingleGlyph(markedGlyphs, gName, 1);

		const unicodeSet = glyphStore.queryUnicodeOf(g);
		if (unicodeSet) {
			for (const u of unicodeSet) {
				if (!subsetFilter.isCharacterIncluded(u)) continue;
				let d = Math.max(1, Math.min(u, 0xffff) >> 4);
				markSingleGlyph(markedGlyphs, gName, d);
			}
		}
	}

	return markedGlyphs;
}

function markGlyphsGr(glyphStore, markedGlyphs, otl) {
	const glyphCount = markedGlyphs.size;
	for (const g of glyphStore.glyphs()) {
		markLinkedGlyph(markedGlyphs, g, VS01);
	}
	const glyphCount1 = markedGlyphs.size;
	return glyphCount1 > glyphCount;
}
function markLinkedGlyph(markedGlyphs, g, gr) {
	const linked = gr.get(g);
	const d = markedGlyphs.get(g);
	if (d && linked) markSingleGlyph(markedGlyphs, linked, d + 0x1000);
}

function markGlyphsByGsub(gsub, markedGlyphs, daGsub) {
	for (const lid of gsub.lookupOrder) {
		if (!daGsub.has(lid)) continue;
		markGlyphsByLookup(gsub, lid, markedGlyphs);
	}
}

function markGlyphsByLookup(gsub, lid, markedGlyphs) {
	const lookup = gsub.lookups[lid];
	if (!lookup) return;
	const handler = LookupTypehHanlderMap[lookup.type];
	if (!handler) return;
	handler.markGlyphs(gsub, lookup, markedGlyphs);
}

function sweepGlyphs(glyphStore, gnSet) {
	return glyphStore.filterByName(gnSet);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

// OTL lookup handlers

const GsubSingle = {
	isEmpty(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const k in st) if (markedGlyphs.has(k)) return false;
		return true;
	},
	markGlyphs(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const k in st) {
			const d = markedGlyphs.get(k);
			if (d && st[k]) markSingleGlyph(markedGlyphs, st[k], d + 0x1000);
		}
	},
};
const GsubMultipleAlternate = {
	isEmpty(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const k in st) if (markedGlyphs.has(k)) return false;
		return true;
	},
	markGlyphs(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const k in st) {
			const d = markedGlyphs.get(k);
			if (d && st[k]) for (const g of st[k]) markSingleGlyph(markedGlyphs, g, d + 0x1000);
		}
	},
};
const GsubLigature = {
	isEmpty(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const sub of st) {
			// Check all of the glyphs are in the marked glyphs set
			let allGlyphsInSet = true;
			for (const g of sub.from) {
				if (!markedGlyphs.has(g)) {
					allGlyphsInSet = false;
					break;
				}
			}
			// If all glyphs are in the marked glyphs set, then this substitution is valid,
			// thus the lookup is not empty. Return false.
			if (allGlyphsInSet) return false;
		}
		return true;
	},
	markGlyphs(gsub, lookup, markedGlyphs) {
		const st = lookup.substitutions;
		for (const sub of st) {
			let maxD = 0;
			for (const g of sub.from) {
				const d = markedGlyphs.get(g);
				if (d && d > maxD) maxD = d;
			}
			if (maxD && sub.to) markSingleGlyph(markedGlyphs, sub.to, maxD + 0x1000);
		}
	},
};
const GsubChaining = {
	isEmpty(gsub, lookup, markedGlyphs) {
		rules: for (const rule of lookup.rules) {
			if (!rule.match || !rule.apply) continue rules;
			// Check if all match coverages have at least one glyph in the marked glyphs set
			// If not, skip to next rule
			for (const m of rule.match) {
				let atLeastOneMatch = false;
				for (const matchGlyph of m)
					if (markedGlyphs.has(matchGlyph)) atLeastOneMatch = true;
				if (!atLeastOneMatch) continue rules;
			}

			// Check all the applications. If all of them are empty, skip to next rule.
			let allApplicationsAreEmpty = true;
			for (const app of rule.apply) {
				if (!app.lookup.name) throw new Error("Unreachable: lookup name should be present");
				if (!isLookupEmpty(gsub, app.lookup.name, markedGlyphs)) {
					allApplicationsAreEmpty = false;
					break;
				}
			}
			if (allApplicationsAreEmpty) continue rules;

			// This rule is valid, return false
			return false;
		}
		return true;
	},
	markGlyphs(gsub, lookup, markedGlyphs) {
		rules: for (const rule of lookup.rules) {
			// Check whether all match coverages has at least one glyph in the sink
			for (const m of rule.match) {
				let atLeastOneMatch = false;
				for (const matchGlyph of m)
					if (markedGlyphs.has(matchGlyph)) atLeastOneMatch = true;
				if (!atLeastOneMatch) continue rules;
			}
			// If so traverse through the lookup applications
			for (const app of rule.apply) {
				if (!app.lookup.name) throw new Error("Unreachable: lookup name should be present");
				markGlyphsByLookup(gsub, app.lookup.name, markedGlyphs);
			}
		}
	},
};
const GsubReverse = {
	isEmpty(gsub, lookup, markedGlyphs) {
		if (!lookup.rules) return true;
		rules: for (const rule of lookup.rules) {
			// Check if all match coverages have at least one glyph in the marked glyphs set
			// If not, skip to next rule
			if (!rule.match || !rule.to) continue rules;
			for (const m of rule.match) {
				let atLeastOneMatch = false;
				for (const matchGlyph of m)
					if (markedGlyphs.has(matchGlyph)) atLeastOneMatch = true;
				if (!atLeastOneMatch) continue rules;
			}

			// This rule is valid, return false
			return false;
		}
		return true;
	},
	markGlyphs(gsub, lookup, markedGlyphs) {
		for (const rule of lookup.rules) {
			if (rule.match && rule.to) {
				const matchCoverage = rule.match[rule.inputIndex];
				for (let j = 0; j < matchCoverage.length; j++) {
					const d = markedGlyphs.get(matchCoverage[j]);
					if (d && rule.to[j]) markSingleGlyph(markedGlyphs, rule.to[j], d + 0x1000);
				}
			}
		}
	},
};

const LookupTypehHanlderMap = {
	gsub_single: GsubSingle,
	gsub_multiple: GsubMultipleAlternate,
	gsub_alternate: GsubMultipleAlternate,
	gsub_ligature: GsubLigature,
	gsub_chaining: GsubChaining,
	gsub_reverse: GsubReverse,
	// nothing to do here for gpos
};

///////////////////////////////////////////////////////////////////////////////////////////////////

function analyzeReferenceGraph(glyphStore, markedGlyphs) {
	let depthMap = new Map();
	let aliasMap = new Map();

	for (const [gn, g] of glyphStore.namedEntries()) {
		const d = markedGlyphs.get(gn);
		if (d) traverseReferenceTree(depthMap, aliasMap, g, d);
	}
	aliasMap = optimizeAliasMap(aliasMap, depthMap);

	let memo = new Set();
	for (const [gn, g] of glyphStore.namedEntries()) {
		const d = markedGlyphs.get(gn);
		if (d) rectifyGlyphAndMarkComponents(glyphStore, aliasMap, markedGlyphs, memo, g, d);
	}
}

// Traverse the glyphs' reference tree and mark the depth of each glyph.
// For aliases (a glyphs which only contains a single reference), mark the aliasing relationship.
function traverseReferenceTree(depthMap, aliasMap, g, d) {
	depthMapSet(depthMap, g, d);

	let refs = g.geometry.toReferences();
	if (!refs) return;

	for (const sr of refs) {
		traverseReferenceTree(depthMap, aliasMap, sr.glyph, d + 0x10000);
	}
	if (refs.length === 1) {
		const sr = refs[0];
		aliasMap.set(g, sr);
	}
}

function depthMapSet(depthMap, g, d) {
	let existing = depthMap.get(g);
	if (null == existing || d < existing) {
		depthMap.set(g, d);
		return d;
	} else {
		return existing;
	}
}

// Optimize the alias map by altering the geometry of glyphs to reference the "representative glyph",
// which is the glyph with the smallest depth in the cluster of glyphs that aliased to each other.
function optimizeAliasMap(aliasMap, depthMap) {
	let collection = collectAliasMap(aliasMap);
	resolveCollectionRepresentative(collection, depthMap);
	return alterGeometryAndOptimize(collection);
}

// Collect all glyphs into clusters, grouped by the terminal glyph of alias chains.
// Each cluster will contain all the the glyphs that are aliases of the terminal glyph.
function collectAliasMap(aliasMap) {
	let aliasResolution = new Map();
	for (const g of aliasMap.keys()) {
		const terminal = getAliasTerminal(aliasMap, g);
		let m = aliasResolution.get(terminal.glyph);
		if (!m) {
			m = {
				representative: null,
				aliases: new Map(),
			};
			aliasResolution.set(terminal.glyph, m);
		}
		m.aliases.set(g, { x: terminal.x, y: terminal.y });
	}

	for (const [gT, cluster] of aliasResolution) cluster.aliases.set(gT, { x: 0, y: 0 });
	return aliasResolution;
}

// Resolve the representative glyph of each cluster, using the glyph with the smallest depth.
function resolveCollectionRepresentative(collection, depthMap) {
	for (const [gT, cluster] of collection) {
		let d = null;
		for (const [g, tf] of cluster.aliases) {
			const dt = depthMap.get(g);
			if ((d == null && dt != null) || (d != null && dt != null && dt < d)) {
				d = dt;
				cluster.representative = { glyph: g, x: tf.x, y: tf.y };
			}
		}
	}
}

// Use the collected alias map to alter the geometry of glyphs and produce the optimized alias map.
// The geometry of each glyph will be altered to reference the representative glyph of its cluster,
// while the representative itself's geometry will be the terminal glyph's geometry with translation.
function alterGeometryAndOptimize(collection) {
	let optimized = new Map();
	for (const [gT, cluster] of collection) {
		if (!cluster.representative) {
			throw new Error("Unreachable: each cluster should have at least one representative");
		}

		cluster.representative.glyph.geometry = Geometry.TransformedGeometry.create(
			Transform.Translate(cluster.representative.x, cluster.representative.y),
			gT.geometry,
		);

		for (const [g, tf] of cluster.aliases) {
			if (g != cluster.representative.glyph) {
				g.geometry = new Geometry.ReferenceGeometry(
					cluster.representative.glyph,
					tf.x - cluster.representative.x,
					tf.y - cluster.representative.y,
				);
				optimized.set(g, {
					glyph: cluster.representative.glyph,
					x: tf.x - cluster.representative.x,
					y: tf.y - cluster.representative.y,
				});
			}
		}
	}
	return optimized;
}

function getAliasTerminal(aliasMap, g) {
	let x = 0,
		y = 0;
	for (;;) {
		const alias = aliasMap.get(g);
		if (!alias) {
			return { glyph: g, x, y };
		} else {
			x += alias.x;
			y += alias.y;
			g = alias.glyph;
		}
	}
}

function rectifyGlyphAndMarkComponents(glyphStore, aliasMap, markedGlyphs, memo, g, d) {
	if (memo.has(g)) return;
	memo.add(g);

	analyzeRefs: {
		let refs = g.geometry.toReferences();
		if (!refs) break analyzeRefs;

		let partGns = []; // The names of the referenced glyphs
		let parts = []; // The parts of the new geometry
		let hasMarked = false; // Whether any of the referenced glyphs is marked

		for (let sr of refs) {
			// Resolve alias
			const alias = aliasMap.get(sr.glyph);
			if (alias) {
				sr.glyph = alias.glyph;
				sr.x += alias.x;
				sr.y += alias.y;
			}

			// Resolve reference
			const gn = glyphStore.queryNameOf(sr.glyph);
			if (!gn) {
				// Reference is invalid. The root glyph will be radicalized.
				break analyzeRefs;
			} else {
				// Reference is valid. Process the referenced glyph.
				if (markedGlyphs.has(gn)) hasMarked = true;
				rectifyGlyphAndMarkComponents(
					glyphStore,
					aliasMap,
					markedGlyphs,
					memo,
					sr.glyph,
					d + 0x10000,
				);
				parts.push(new Geometry.ReferenceGeometry(sr.glyph, sr.x, sr.y));
				partGns.push(gn);
			}
		}

		// If any of the referenced glyphs is marked, mark all the remaining references.
		if (hasMarked) {
			for (const gn of partGns) if (!markedGlyphs.has(gn)) markedGlyphs.set(gn, d + 0x10000);
			g.geometry = new Geometry.CombineGeometry(parts);
			return;
		}
	}

	// Make the glyph radical if it has no marked references.
	g.geometry = new Geometry.RadicalGeometry(g.geometry);
}
