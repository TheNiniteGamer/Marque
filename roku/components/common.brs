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
    if t = "roInt" or t = "Integer" or t = "roFloat" or t = "Float" or t = "Double" or t = "roDouble" or t = "LongInteger" then return v.ToStr()
    return ""
end function

function mqNum(v as Dynamic) as Float
    if v = invalid then return 0
    t = type(v)
    if t = "roInt" or t = "Integer" or t = "roFloat" or t = "Float" or t = "Double" or t = "roDouble" or t = "LongInteger" then return v
    return 0
end function

' A playback file or picture on the server, signed in with this Roku's device token.
function mqMediaUrl(path as String) as String
    sep = "?"
    if Instr(1, path, "?") > 0 then sep = "&"
    return m.global.server + path + sep + "at=" + m.global.token
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

' A steady colour per person, the same as on the web.
function mqAvatarColor(name as String) as String
    colors = ["0x2F6FB3FF", "0xB3402FFF", "0x7A4FB3FF", "0x2F8A5CFF", "0xB3862FFF", "0x2F9BB3FF", "0xB32F7AFF", "0x5C6B2FFF"]
    n& = 7
    for i = 1 to Len(name)
        n& = (n& * 31 + Asc(Mid(name, i, 1))) mod 4294967296&
    end for
    return colors[n& mod colors.Count()]
end function
