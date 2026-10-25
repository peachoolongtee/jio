# Jio

Jio decides where a group should meet, keeps the plan alive when the weather turns, and suggests what to do once everyone is together. This glossary fixes the words the team uses for that.

## Language

### Meeting spots

**Meeting spot**:
An area the group could meet in, listed on the Locate step with everyone's travel time to it. The app lists up to three; each member may add one.
_Avoid_: Candidate, option (an option is a place in the later vote), venue

**Suggestion**:
A meeting spot a member added. A member has one at a time; a second replaces the first. Marked "we are here already" when the member is there now.
_Avoid_: Nomination, pin

**Works for me**:
A member's approval of a meeting spot. A member may approve any number of spots; there is no order and no score. Approvals advise the host, who confirms.
_Avoid_: Vote (a vote is for a place), like, upvote

**Known place**:
A meeting area the host sets directly because the group has already decided where to meet. It skips the spot list and goes straight to choosing what to do.
_Avoid_: Fixed location, skip mode

**Start choice**:
How the host decides to pick the meeting point, made when they press Start session: find the fairest spot (everyone shares where they start and Jio finds a fair meeting point, the default) or "We already know where" (the host names the area and the group goes straight to choosing places). Guests see which one the host chose. It is the host's intent; the planner's own result is the meeting method. Stored as `sessions.meet_by`, which is null on a session that started before the choice and reads as the fairest spot.
_Avoid_: Mode, meeting method (that is the planner's result), route

### Roam

**Roam**:
The list of things to do near where the group already is. On screen it is "What next?" inside a meetup that is under way, and "Already out? Find something nearby" on Home, which starts a light meetup with no location step.
_Avoid_: Explore, discover

**Proposal**:
A place from the Roam list that a member puts forward as the next stop. It becomes a stop only when the host accepts it.
_Avoid_: Suggestion (that is a meeting spot), request

**Proposed stop**:
A proposal as the itinerary shows it, under the stops: a place with the name of whoever proposed it, no time and no number, waiting for the host to add it to the plan or leave it out. Once added it is a stop, last in the plan.
_Avoid_: Pending stop, suggested stop

**Stop**:
A venue the group actually visits during an event. The venue the group converged on is the first stop.
_Avoid_: Hop, leg, waypoint

**Current point**:
Where the group is right now: the latest stop, or the shared origin when there are no stops yet.
_Avoid_: Location, position, from-venue

**Single-origin event**:
An event whose members are already together at one shared origin, so it skips Converge and opens straight into Roam.
_Avoid_: Tourist mode, local mode

### Needs and weather

**Dietary need**:
A standing limit on what a person can eat: halal, vegetarian or vegan. It belongs to the person, applies to every outing they are in, and is private: the group sees that places were filtered, never whose need it was.
_Avoid_: Dietary requirement, dietary preference, diet

**Unconfirmed place**:
A food place that does not say whether it fits a dietary need. Left out by default, and shown only when the group asks for it, labelled as not confirmed.
_Avoid_: Unknown venue, maybe-halal

**Area forecast**:
The national weather service's forecast for one named area over the next two hours.
_Avoid_: Nowcast, live weather

**Regional forecast**:
The national weather service's forecast for one of the island's regions over the next 24 hours.
_Avoid_: Daily forecast, outlook

**Forecast window**:
The 24 hours before a stop begins, the only time a forecast for it exists. Outside the window, weather has no effect on what is suggested.
_Avoid_: Weather horizon

**Exposed stop**:
A stop that is open-air, or a long walk from shelter.
_Avoid_: Outdoor venue

**Rain warning**:
A mark on an exposed stop when rain is likely there at its time.
_Avoid_: Weather alert

**Indoor swap**:
An indoor place offered in place of a stop with a rain warning. The host accepts or dismisses it.
_Avoid_: Rain plan, backup venue
