'use strict';
/**
 * Minimal, dependency-free GTFS-realtime protobuf reader.
 *
 * We only decode the small, stable subset of the GTFS-RT spec that the
 * County of Hawai‘i (myheleonbus.org) feed actually emits:
 *   - FeedMessage.entity[]
 *   - VehiclePosition (trip, position, stop, timestamp)
 *   - TripUpdate (trip, stop_time_update[] with predicted arrival/departure)
 *   - Alert (informed_entity, header, description)
 *
 * Writing the wire decoder by hand keeps the Render build lean (no
 * gtfs-realtime-bindings / protobufjs dependency) and is plenty fast for
 * a feed of a few dozen entities polled every 15 s.
 *
 * Wire format reference: https://protobuf.dev/programming-guides/encoding/
 */

// Decode a protobuf message body into { fieldNumber: [values] }.
// Length-delimited values are returned as Buffers (decode recursively as needed).
function decodeMessage(buf) {
  let p = 0;
  const out = {};
  while (p < buf.length) {
    let tag = 0, shift = 0, b;
    do { b = buf[p++]; tag |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = tag >>> 3;
    const wireType = tag & 7;
    let val;
    if (wireType === 0) {            // varint
      let v = 0, s = 0, c;
      do { c = buf[p++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80);
      val = v;
    } else if (wireType === 5) {     // 32-bit (float / fixed32)
      val = buf.readFloatLE(p); p += 4;
    } else if (wireType === 1) {     // 64-bit (double / fixed64)
      val = buf.readDoubleLE(p); p += 8;
    } else if (wireType === 2) {     // length-delimited (bytes / string / message)
      let len = 0, s = 0, c;
      do { c = buf[p++]; len |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
      val = buf.slice(p, p + len); p += len;
    } else {
      break; // unknown wire type — bail rather than misread
    }
    (out[field] = out[field] || []).push(val);
  }
  return out;
}

const first = (arr) => (arr && arr.length ? arr[0] : undefined);
const str = (arr) => { const v = first(arr); return v == null ? null : v.toString('utf8'); };
const num = (arr) => { const v = first(arr); return v == null ? null : v; };

// TripDescriptor (FeedEntity → *.trip)
function parseTrip(buf) {
  if (!buf) return null;
  const t = decodeMessage(buf);
  return {
    tripId: str(t[1]),
    routeId: str(t[5]),       // often absent in this feed; trip_id encodes route
    startDate: str(t[3]),     // YYYYMMDD
    startTime: str(t[2]),     // HH:MM:SS
  };
}

// VehiclePosition
function parseVehiclePosition(buf) {
  const v = decodeMessage(buf);
  const trip = v[1] ? parseTrip(v[1][0]) : null;
  let lat = null, lon = null, bearing = null, speed = null;
  if (v[2]) {
    const pos = decodeMessage(v[2][0]);
    lat = num(pos[1]); lon = num(pos[2]); bearing = num(pos[3]); speed = num(pos[5]);
  }
  let vehId = null, vehLabel = null;
  if (v[8]) { const vd = decodeMessage(v[8][0]); vehId = str(vd[1]); vehLabel = str(vd[2]); }
  return {
    trip,
    lat, lon, bearing,
    speed,                        // metres/second per spec
    currentStopSeq: num(v[3]),
    currentStatus: num(v[4]),     // 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO
    timestamp: num(v[5]),         // epoch seconds
    stopId: str(v[7]),
    vehicleId: vehId,
    vehicleLabel: vehLabel,
  };
}

// StopTimeEvent (arrival / departure)
function parseStopTimeEvent(buf) {
  if (!buf) return null;
  const e = decodeMessage(buf);
  return { delay: num(e[1]), time: num(e[2]), uncertainty: num(e[3]) };
}

// TripUpdate
function parseTripUpdate(buf) {
  const t = decodeMessage(buf);
  const trip = t[1] ? parseTrip(t[1][0]) : null;
  const stopTimeUpdates = (t[2] || []).map((stuBuf) => {
    const stu = decodeMessage(stuBuf);
    return {
      stopSeq: num(stu[1]),
      stopId: str(stu[4]),
      arrival: stu[2] ? parseStopTimeEvent(stu[2][0]) : null,
      departure: stu[3] ? parseStopTimeEvent(stu[3][0]) : null,
      scheduleRelationship: num(stu[5]),
    };
  });
  let vehicleId = null;
  if (t[3]) { const vd = decodeMessage(t[3][0]); vehicleId = str(vd[1]) || str(vd[2]); }
  return {
    trip,
    vehicleId,                 // TripUpdate.vehicle (VehicleDescriptor)
    timestamp: num(t[4]),
    delay: num(t[5]),
    stopTimeUpdates,
  };
}

// Top-level FeedMessage → list of { id, vehicle?, tripUpdate? }
function parseFeedMessage(buf) {
  const msg = decodeMessage(buf);
  const entities = msg[2] || [];
  return entities.map((entBuf) => {
    const ent = decodeMessage(entBuf);
    const out = { id: str(ent[1]) };
    if (ent[4]) out.vehicle = parseVehiclePosition(ent[4][0]);   // FeedEntity.vehicle
    if (ent[3]) out.tripUpdate = parseTripUpdate(ent[3][0]);     // FeedEntity.trip_update
    return out;
  });
}

module.exports = { parseFeedMessage, decodeMessage };
