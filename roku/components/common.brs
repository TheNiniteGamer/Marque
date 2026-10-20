' Helpers shared by the screens: settings saved on the Roku, server addresses, and turning the
' server's titles into content nodes for rows and grids.

function mqRead(key as String) as String
    sec = CreateObject("roRegistrySection", "marquee")
    if sec.Exists(key) then return sec.Read(key)
    return ""
end function

sub mqWrite(key as String, value as String)
    sec = CreateObject("roRegistrySection", "marquee")
    sec.Write(key, value)
    sec.Flush()
end sub

sub mqDelete(key as String)
    sec = CreateObject("roRegistrySection", "marquee")
    sec.Delete(key)
    sec.Flush()
end sub

function mqIsTrue(v as Dynamic) as Boolean
    if v = invalid then return false
    t = type(v)
    if t = "roBoolean" or t = "Boolean" then return v
    return false
end function

function mqStr(v as Dynamic) as String
    if v = invalid then return ""
    t = type(v)
    if t = "roString" or t = "String" then return v
    if mqIsNumber(v) then return v.ToStr()
    return ""
end function

function mqNum(v as Dynamic) as Float
    if mqIsNumber(v) then return v
    return 0
end function

' (Numbers from ParseJson are "roInteger" / "roFloat"; ones made in code "Integer", "Float"…)
function mqIsNumber(v as Dynamic) as Boolean
    if v = invalid then return false
    t = type(v)
    return t = "roInt" or t = "roInteger" or t = "Integer" or t = "roFloat" or t = "Float" or t = "Double" or t = "roDouble" or t = "LongInteger" or t = "roLongInteger"
end function

' A playback file or picture on the server. The address carries the media key, which opens only
' pictures and videos (so the sign-in itself never ends up in an address); until the key has
' arrived, the sign-in is used as before.
function mqMediaUrl(path as String) as String
    sep = "?"
    if Instr(1, path, "?") > 0 then sep = "&"
    key = m.global.mediaKey
    if key = invalid or key = "" then key = m.global.token
    return m.global.server + path + sep + "at=" + key
end function

' kind: "backdrop", "poster" or "thumb".
function mqArt(kind as String, item as Object) as String
    v = mqStr(item.artV)
    return mqMediaUrl("/api/art/" + kind + "/" + item.id + "?v=" + v)
end function

' For a search term in an address (UTF-8, percent-encoded).
function mqEscape(s as String) as String
    out = ""
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(s)
    for each b in bytes
        if (b >= 48 and b <= 57) or (b >= 65 and b <= 90) or (b >= 97 and b <= 122) or b = 45 or b = 46 or b = 95 or b = 126 then
            out = out + Chr(b)
        else
            h = UCase(StrI(b, 16))
            if Len(h) = 1 then h = "0" + h
            out = out + "%" + h
        end if
    end for
    return out
end function

function mqDuration(sec as Dynamic) as String
    s = mqNum(sec)
    if s <= 0 then return ""
    mins = Int(s / 60 + 0.5)
    if mins < 1 then return "1 min"
    if mins < 60 then return mins.ToStr() + " min"
    h = Int(mins / 60)
    r = mins - h * 60
    if r = 0 then return h.ToStr() + " hr"
    return h.ToStr() + " hr " + r.ToStr() + " min"
end function

function mqEpLabel(item as Object) as String
    if item.season = invalid and item.episode = invalid then return ""
    out = ""
    if item.season <> invalid then out = "S" + mqStr(item.season)
    if item.episode <> invalid then
        if out <> "" then out = out + ":"
        out = out + "E" + mqStr(item.episode)
    end if
    return out
end function

function mqTimeLeft(item as Object) as String
    p = item.progress
    if p = invalid or type(p) <> "roAssociativeArray" then return ""
    if mqIsTrue(p.watched) or mqNum(p.position) <= 0 or mqNum(item.duration) <= 0 then return ""
    left = mqNum(item.duration) - mqNum(p.position)
    if left < 60 then left = 60
    return mqDuration(left) + " left"
end function

' Card content for rows and grids: the title on the artwork, progress, unwatched count.
function mqCard(item as Object) as Object
    c = CreateObject("roSGNode", "ContentNode")
    kind = mqStr(item.type)
    title = mqStr(item.title)
    art = "backdrop"
    sub_ = ""
    if kind = "episode" then
        title = mqStr(item.showTitle)
        art = "thumb"
        sub_ = mqEpLabel(item) + " · " + mqStr(item.title)
    else if kind = "extra" then
        art = "thumb"
        sub_ = mqStr(item.extraLabel)
    else if kind = "show" then
        sub_ = mqStr(item.seasonCount) + " seasons"
    else
        sub_ = mqStr(item.year)
    end if
    progress = 0.0
    p = item.progress
    if p <> invalid and type(p) = "roAssociativeArray" and not mqIsTrue(p.watched) and mqNum(item.duration) > 0 then
        progress = mqNum(p.position) / mqNum(item.duration)
    end if
    badge = ""
    if kind = "show" and mqNum(item.unwatchedCount) > 0 and mqNum(item.unwatchedCount) < mqNum(item.episodeCount) then badge = mqStr(item.unwatchedCount)
    ' Top 10 in your house: the rank.
    if item.rank <> invalid then badge = "#" + mqStr(item.rank)
    c.addFields({ kind: kind, progress: progress, badge: badge, sub: sub_, data: item })
    c.id = item.id
    c.title = title
    c.HDPosterUrl = mqArt(art, item)
    return c
end function

' Someone in the cast: their photo (or their initial on a colour), name and part.
function mqPersonCard(p as Object) as Object
    c = CreateObject("roSGNode", "ContentNode")
    c.addFields({ kind: "person", progress: 0.0, badge: "", sub: mqStr(p.character), data: { type: "person", name: mqStr(p.name) }, initial: UCase(Left(mqStr(p.name), 1)), tint: mqAvatarColor(mqStr(p.name)) })
    c.title = mqStr(p.name)
    if p.photo <> invalid and mqStr(p.photo) <> "" then
        ' (/api/people/<name>/photo, or a full address)
        if Left(mqStr(p.photo), 1) = "/" then c.HDPosterUrl = mqMediaUrl(mqStr(p.photo)) else c.HDPosterUrl = mqStr(p.photo)
    end if
    return c
end function

' A collection or franchise: its cover title's artwork, its name and how many titles.
function mqCollectionCard(col as Object) as Object
    c = CreateObject("roSGNode", "ContentNode")
    c.addFields({ kind: "collection", progress: 0.0, badge: "", sub: mqStr(col.count) + " titles", data: col })
    c.id = mqStr(col.id)
    c.title = mqStr(col.name)
    if col.cover <> invalid then c.HDPosterUrl = mqArt("backdrop", col.cover)
    return c
end function

' Where choosing a card goes: episodes and extras play, collections and people open their titles,
' movies and shows their details. Coming soon: the show's details (a film not here yet has none).
function mqOpen(item as Object) as Dynamic
    kind = mqStr(item.type)
    if kind = "upcoming" then
        if item.showId <> invalid then return { screen: "DetailsScreen", params: { id: item.showId, kind: "show" } }
        return invalid
    end if
    if kind = "episode" then return { screen: "PlayerScreen", params: { id: item.id, start: -1 } }
    if kind = "extra" then return { screen: "PlayerScreen", params: { id: item.id, start: 0 } }
    if kind = "person" then return { screen: "GridScreen", params: { title: item.name, path: "/api/people/" + mqEscape(item.name), current: "" } }
    if kind = "collection" or item.memberIds <> invalid then return { screen: "GridScreen", params: { title: mqStr(item.name), path: "/api/collections/" + mqStr(item.id), current: "", collection: true } }
    return { screen: "DetailsScreen", params: { id: item.id, kind: kind } }
end function

' The ✱ options of a card: { title, labels, acts } (invalid for cards without any).
' inContinue: the card is in Continue Watching (it can be taken out of it).
function mqCardMenu(item as Object, inContinue as Boolean) as Dynamic
    kind = mqStr(item.type)
    if kind <> "movie" and kind <> "show" and kind <> "episode" then return invalid
    acts = [{ label: "Details", act: "details" }]
    if kind = "episode" and item.showId <> invalid then acts.Push({ label: "Go to " + mqStr(item.showTitle), act: "show" })
    if inContinue then acts.Push({ label: "Remove from Continue Watching", act: "hide" })
    if kind <> "episode" then
        if mqIsTrue(item.inWatchlist) then acts.Push({ label: "Remove from My List", act: "list" }) else acts.Push({ label: "Add to My List", act: "list" })
    end if
    if mqWatched(item) then acts.Push({ label: "Mark unwatched", act: "watched" }) else acts.Push({ label: "Mark watched", act: "watched" })
    labels = []
    for each a in acts
        labels.Push(a.label)
    end for
    title = mqStr(item.title)
    if kind = "episode" then title = mqStr(item.showTitle) + " · " + mqEpLabel(item)
    return { title: title, labels: labels, acts: acts }
end function

function mqWatched(item as Object) as Boolean
    if mqStr(item.type) = "show" then return mqNum(item.episodeCount) > 0 and mqNum(item.unwatchedCount) = 0
    return item.progress <> invalid and type(item.progress) = "roAssociativeArray" and mqIsTrue(item.progress.watched)
end function

' Does what was picked in a card's menu: returns where to go (details), or starts the change on
' the server and calls `callback` when it's done (to reload the page).
function mqCardAct(item as Object, action as String, callback as String) as Dynamic
    kind = mqStr(item.type)
    if action = "details" then return { screen: "DetailsScreen", params: { id: item.id, kind: kind } }
    if action = "show" then return { screen: "DetailsScreen", params: { id: item.showId, kind: "show" } }
    if action = "hide" then
        mqApi("/api/continue/" + item.id + "/hide", callback, "POST", {})
    else if action = "list" then
        method = "PUT"
        if mqIsTrue(item.inWatchlist) then method = "DELETE"
        mqApi("/api/watchlist/" + item.id, callback, method)
    else if action = "watched" then
        if kind = "show" then
            mqApi("/api/shows/" + item.id + "/watched", callback, "POST", { watched: not mqWatched(item) })
        else
            mqApi("/api/items/" + item.id + "/watched", callback, "POST", { watched: not mqWatched(item) })
        end if
    end if
    return invalid
end function

' "Coming soon" (a show's next episode, or a film on its way): its artwork and when.
function mqUpcomingCard(item as Object) as Object
    c = CreateObject("roSGNode", "ContentNode")
    sub_ = mqStr(item.release)
    if item.kind = "episode" then
        sub_ = "S" + mqStr(item.season) + ":E" + mqStr(item.episode)
        if item.episodeTitle <> invalid then sub_ = sub_ + " · " + mqStr(item.episodeTitle)
    end if
    c.addFields({ kind: "upcoming", progress: 0.0, badge: mqSoonDate(mqStr(item.airDate)), sub: sub_, data: item })
    c.id = item.id
    c.title = mqStr(item.title)
    if item.kind = "episode" then
        c.HDPosterUrl = mqArt("backdrop", { id: item.showId, artV: item.artV })
    else if item.image <> invalid then
        c.HDPosterUrl = mqStr(item.image)
    end if
    return c
end function

' "Today", "Tomorrow", "Fri", or "24 Oct" for an ISO date.
function mqSoonDate(iso as String) as String
    when = CreateObject("roDateTime")
    when.FromISO8601String(Left(iso, 10) + " 12:00:00")
    today = CreateObject("roDateTime")
    today.ToLocalTime()
    today.FromISO8601String(Left(today.ToISOString(), 10) + " 12:00:00")
    days = Int((when.AsSeconds() - today.AsSeconds()) / 86400)
    if days <= 0 then return "Today"
    if days = 1 then return "Tomorrow"
    if days < 7 then return Left(when.GetWeekday(), 3)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return when.GetDayOfMonth().ToStr() + " " + months[when.GetMonth() - 1]
end function

' Starts a request to the server; `callback` (a function name in the caller) gets the response
' { status, data, error, tag } as the event's data.
function mqApi(path as String, callback as String, method = "GET" as String, body = invalid as Dynamic, tag = "" as String) as Object
    t = CreateObject("roSGNode", "ApiTask")
    t.request = { path: path, method: method, body: body, tag: tag }
    t.observeField("response", callback)
    t.control = "RUN"
    if m.tasks = invalid then m.tasks = []
    ' Keep a reference until it's done; drop finished ones.
    keep = [t]
    for each old in m.tasks
        if old.state <> "done" and old.state <> "stop" then keep.Push(old)
    end for
    m.tasks = keep
    return t
end function

' 0:42 / 12:05 / 1:02:33
function mqClock(sec as Dynamic) as String
    s = Int(mqNum(sec))
    if s < 0 then s = 0
    h = Int(s / 3600)
    mi = Int((s - h * 3600) / 60)
    se = s - h * 3600 - mi * 60
    ss = se.ToStr()
    if se < 10 then ss = "0" + ss
    if h > 0 then
        ms = mi.ToStr()
        if mi < 10 then ms = "0" + ms
        return h.ToStr() + ":" + ms + ":" + ss
    end if
    return mi.ToStr() + ":" + ss
end function

' Is this node on screen (it and everything it sits in visible)? Screens under the one you're
' looking at are hidden, and must never act on keys.
function mqShown(node as Object) as Boolean
    n = node
    while n <> invalid
        if not n.visible then return false
        n = n.getParent()
    end while
    return true
end function

' What choosing something in the top bar (TopBar) opens. fromHome: the bar is on Home; elsewhere a
' library replaces the page you're on, and Home goes back to it.
function mqTopBarNav(c as Object, fromHome as Boolean) as Object
    if c.key = "home" then return { screen: "HomeScreen", reset: true }
    if c.key = "search" then return { screen: "SearchScreen" }
    if c.key = "profiles" then return { screen: "ProfilesScreen", params: {} }
    if c.key = "bell" then return { screen: "NotificationsScreen", params: {} }
    if c.key = "requests" then return { screen: "RequestsScreen", params: {} }
    if c.key = "settings" then return { screen: "SettingsScreen", params: {} }
    if c.key = "collections" then return { screen: "CollectionsScreen", params: {}, replace: not fromHome }
    params = { title: "My List", path: "/api/watchlist", current: "list" }
    if c.key = "lib" then params = { title: mqStr(c.title), path: "/api/libraries/" + mqStr(c.id) + "/items", current: "lib:" + mqStr(c.id) }
    return { screen: "GridScreen", params: params, replace: not fromHome }
end function

' A steady colour per person, the same as on the web.
function mqAvatarColor(name as String) as String
    colors = ["0x2F6FB3FF", "0xB3402FFF", "0x7A4FB3FF", "0x2F8A5CFF", "0xB3862FFF", "0x2F9BB3FF", "0xB32F7AFF", "0x5C6B2FFF"]
    n& = 7
    for i = 1 to Len(name)
        n& = (n& * 31 + Asc(Mid(name, i, 1))) mod 4294967296&
    end for
    return colors[CInt(n& mod colors.Count())]
end function
