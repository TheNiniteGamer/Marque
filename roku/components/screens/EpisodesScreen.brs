sub init()
    m.title = m.top.findNode("title")
    m.seasons = m.top.findNode("seasons")
    m.episodes = m.top.findNode("episodes")
    m.focus = m.episodes
    m.top.observeField("focusedChild", "onFocusChange")
    m.seasons.observeField("itemFocused", "onSeasonFocused")
    m.episodes.observeField("itemSelected", "onEpisodeSelected")
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

sub load()
    mqApi("/api/shows/" + m.top.params.id, "onLoaded")
end sub

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
        if m.season <> invalid and s.season = m.season then pick = i
        if m.season = invalid and m.top.params.season <> invalid and s.season = m.top.params.season then pick = i
        i = i + 1
    end for
    m.seasons.content = root
    m.seasons.jumpToItem = pick
    m.episodes.content = invalid ' rebuilt with the latest progress
    showSeason(pick)
    if m.top.isInFocusChain() then m.focus.setFocus(true)
end sub

sub onSeasonFocused()
    showSeason(m.seasons.itemFocused)
end sub

sub showSeason(index as Integer)
    if m.show = invalid or index < 0 or index >= m.show.seasons.Count() then return
    season = m.show.seasons[index]
    if m.season <> invalid and m.season = season.season and m.episodes.content <> invalid then return
    m.season = season.season
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
        c.description = mqStr(e.overview)
        root.appendChild(c)
        if m.show.upNext <> invalid and m.show.upNext.id = e.id then focusAt = i
        i = i + 1
    end for
    m.episodes.content = root
    m.episodes.jumpToItem = focusAt
end sub

sub onEpisodeSelected()
    e = m.list[m.episodes.itemSelected]
    if e <> invalid then m.top.navigate = { screen: "PlayerScreen", params: { id: e.id, start: -1 } }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
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
