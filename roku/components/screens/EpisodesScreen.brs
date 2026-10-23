sub init()
    m.title = m.top.findNode("title")
    m.seasons = m.top.findNode("seasons")
    m.episodes = m.top.findNode("episodes")
    m.focus = m.episodes
    m.top.observeField("focusedChild", "onFocusChange")
    m.seasons.observeField("itemFocused", "onSeasonFocused")
    m.episodes.observeField("itemSelected", "onEpisodeSelected")
    m.menu = m.top.findNode("menu")
    m.menu.observeField("chosen", "onMenuChosen")
    m.menu.observeField("closed", "onMenuClosed")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.focus.setFocus(true)
end sub

sub onParams()
    m.title.text = mqStr(m.top.params.title)
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

' One season's episodes at a time (long shows have a thousand): the one shown, else the next to watch's.
sub load()
    key = m.key
    if key = invalid and m.top.params.season <> invalid then key = seasonKey(m.top.params.season)
    if key = invalid then key = "auto"
    mqApi("/api/shows/" + m.top.params.id + "?episodes=" + key, "onLoaded")
end sub

' "3", "0" (specials) or "null" (unsorted), as the server takes it.
function seasonKey(n as Dynamic) as String
    if n = invalid then return "null"
    return mqStr(n)
end function

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.title.text = "Can't load the episodes: " + r.error
        return
    end if
    m.show = r.data
    m.title.text = mqStr(m.show.title)
    root = CreateObject("roSGNode", "ContentNode")
    pick = 0
    i = 0
    for each s in m.show.seasons
        n = root.createChild("ContentNode")
        n.title = mqStr(s.title)
        if s.episodes <> invalid then pick = i
        i = i + 1
    end for
    ' (After a change in the same season, the highlight stays on the same episode.)
    keep = -1
    if m.episodes.content <> invalid and m.key <> invalid then keep = m.episodes.itemFocused
    m.seasons.content = root
    m.seasons.jumpToItem = pick
    m.key = invalid
    m.episodes.content = invalid ' rebuilt with the latest progress
    showSeason(pick)
    if keep >= 0 and keep < m.episodes.content.getChildCount() then m.episodes.jumpToItem = keep
    ' (Not while a menu is open: it keeps the highlight.)
    if m.top.isInFocusChain() and not m.menu.visible then m.focus.setFocus(true)
end sub

sub onSeasonFocused()
    showSeason(m.seasons.itemFocused)
end sub

sub showSeason(index as Integer)
    if m.show = invalid or index < 0 or index >= m.show.seasons.Count() then return
    season = m.show.seasons[index]
    key = seasonKey(season.season)
    if m.key <> invalid and m.key = key and m.episodes.content <> invalid then return
    m.seasonData = season
    m.key = key
    if season.episodes = invalid then
        ' Fetched now; shown if this season is still the one picked when it arrives.
        m.list = []
        m.episodes.content = CreateObject("roSGNode", "ContentNode")
        mqApi("/api/shows/" + m.top.params.id + "/episodes?season=" + key, "onSeasonLoaded")
        return
    end if
    m.list = season.episodes
    root = CreateObject("roSGNode", "ContentNode")
    focusAt = 0
    i = 0
    for each e in season.episodes
        c = mqCard(e)
        num = ""
        if e.episode <> invalid then num = mqStr(e.episode) + ". "
        c.title = num + mqStr(e.title)
        c.sub = mqDuration(e.duration)
        if e.absoluteNumber <> invalid then c.sub = "#" + mqStr(e.absoluteNumber) + "  ·  " + c.sub
        if mqWatched(e) then c.sub = "Watched  ·  " + c.sub
        c.description = mqStr(e.overview)
        root.appendChild(c)
        if m.show.upNext <> invalid and m.show.upNext.id = e.id then focusAt = i
        i = i + 1
    end for
    m.episodes.content = root
    m.episodes.jumpToItem = focusAt
end sub

sub onSeasonLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid or m.show = invalid then return
    key = seasonKey(r.data.season)
    i = 0
    for each s in m.show.seasons
        if seasonKey(s.season) = key then
            s.episodes = r.data.episodes
            if m.key = key then
                m.key = invalid
                showSeason(i)
            end if
        end if
        i = i + 1
    end for
end sub

sub onEpisodeSelected()
    e = m.list[m.episodes.itemSelected]
    if e <> invalid then m.top.navigate = { screen: "PlayerScreen", params: { id: e.id, start: -1 } }
end sub

' ✱: the highlighted episode's options, or the season's.
sub openMenu()
    acts = []
    if m.episodes.hasFocus() then
        e = m.list[m.episodes.itemFocused]
        if e = invalid then return
        m.menuEp = e
        acts.Push({ label: "Details", act: "details" })
        acts.Push({ label: "Play from the start", act: "start" })
        if mqWatched(e) then acts.Push({ label: "Mark unwatched", act: "watched" }) else acts.Push({ label: "Mark watched", act: "watched" })
        title = mqEpLabel(e) + " · " + mqStr(e.title)
    else
        title = mqStr(m.seasonData.title)
    end if
    all = seasonWatched()
    if all then acts.Push({ label: "Mark " + mqStr(m.seasonData.title) + " unwatched", act: "season" }) else acts.Push({ label: "Mark " + mqStr(m.seasonData.title) + " watched", act: "season" })
    m.menuActs = acts
    labels = []
    for each a in acts
        labels.Push(a.label)
    end for
    m.menu.title = title
    m.menu.options = labels
    m.menu.current = -1
    m.menu.open = true
end sub

function seasonWatched() as Boolean
    if m.seasonData = invalid then return false
    if m.seasonData.episodes = invalid then return mqIsTrue(m.seasonData.watched)
    for each e in m.seasonData.episodes
        if not mqWatched(e) then return false
    end for
    return true
end function

sub onMenuChosen()
    m.focus.setFocus(true)
    a = m.menuActs[m.menu.chosen]
    if a.act = "details" then
        m.top.navigate = { screen: "DetailsScreen", params: { id: m.menuEp.id, kind: "episode" } }
    else if a.act = "start" then
        m.top.navigate = { screen: "PlayerScreen", params: { id: m.menuEp.id, start: 0 } }
    else if a.act = "watched" then
        mqApi("/api/items/" + m.menuEp.id + "/watched", "onChanged", "POST", { watched: not mqWatched(m.menuEp) })
    else if a.act = "season" then
        mqApi("/api/shows/" + m.top.params.id + "/watched", "onChanged", "POST", { season: m.seasonData.season, watched: not seasonWatched() })
    end if
end sub

sub onMenuClosed()
    m.focus.setFocus(true)
end sub

sub onChanged()
    load()
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "options" and m.show <> invalid then
        openMenu()
        return true
    end if
    if key = "left" and m.episodes.hasFocus() then
        m.focus = m.seasons
        m.seasons.setFocus(true)
        return true
    end if
    if key = "right" and m.seasons.hasFocus() then
        m.focus = m.episodes
        m.episodes.setFocus(true)
        return true
    end if
    return false
end function
