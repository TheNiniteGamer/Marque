sub init()
    m.backdrop = m.top.findNode("backdrop")
    m.eyebrow = m.top.findNode("eyebrow")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.progress = m.top.findNode("progress")
    m.overview = m.top.findNode("overview")
    m.buttons = m.top.findNode("buttons")
    m.side = m.top.findNode("side")
    m.actions = []
    m.top.observeField("focusedChild", "onFocusChange")
    m.buttons.observeField("buttonSelected", "onButton")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.buttons.setFocus(true)
end sub

sub onParams()
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    p = m.top.params
    if p.kind = "show" then mqApi("/api/shows/" + p.id, "onLoaded") else mqApi("/api/items/" + p.id, "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.title.text = "Can't load this title"
        m.overview.text = r.error
        return
    end if
    x = r.data
    m.item = x
    kind = mqStr(x.type)
    isEp = kind = "episode" or kind = "extra"
    art = "backdrop"
    if isEp then art = "thumb"
    m.backdrop.uri = mqArt(art, x)
    m.title.text = mqStr(x.title)
    m.eyebrow.text = ""
    if kind = "episode" then m.eyebrow.text = UCase(mqStr(x.showTitle) + "  ·  " + mqEpLabel(x))
    parts = []
    if x.year <> invalid and kind <> "episode" then parts.Push(mqStr(x.year))
    if kind = "show" then
        parts.Push(mqStr(x.seasonCount) + " seasons")
        parts.Push(mqStr(x.episodeCount) + " episodes")
    else
        parts.Push(mqDuration(x.duration))
    end if
    if x.contentRating <> invalid then parts.Push(mqStr(x.contentRating))
    if x.rating <> invalid then parts.Push("★ " + mqStr(x.rating))
    m.meta.text = parts.Join("   ")
    m.overview.text = mqStr(x.overview)

    side = []
    if x.genres <> invalid and x.genres.Count() > 0 then side.Push("Genres: " + x.genres.Join(", "))
    if x.cast <> invalid and x.cast.Count() > 0 then
        names = []
        for each c in x.cast
            if names.Count() < 5 then names.Push(c.name)
        end for
        side.Push("Cast: " + names.Join(", "))
    end if
    m.side.text = side.Join(Chr(10))

    ' What can be done: a list of [label, action].
    m.actions = []
    m.progress.text = ""
    if kind = "show" then
        up = x.upNext
        if up <> invalid then
            label = "Play " + mqEpLabel(up)
            if up.progress <> invalid and mqNum(up.progress.position) > 0 and not mqIsTrue(up.progress.watched) then
                label = "Resume " + mqEpLabel(up)
                m.progress.text = mqEpLabel(up) + " · " + mqStr(up.title) + " — " + mqTimeLeft(up)
            end if
            m.actions.Push({ label: label, act: "play", id: up.id, start: -1 })
        end if
        m.actions.Push({ label: "Episodes", act: "episodes" })
    else
        p = x.progress
        resumable = p <> invalid and not mqIsTrue(p.watched) and mqNum(p.position) > 15
        if resumable then
            m.actions.Push({ label: "Resume", act: "play", id: x.id, start: -1 })
            m.actions.Push({ label: "Play from the start", act: "play", id: x.id, start: 0 })
            m.progress.text = mqTimeLeft(x)
        else
            m.actions.Push({ label: "Play", act: "play", id: x.id, start: 0 })
        end if
    end if
    if kind = "show" or kind = "movie" then
        if mqIsTrue(x.inWatchlist) then m.actions.Push({ label: "Remove from My List", act: "list" }) else m.actions.Push({ label: "Add to My List", act: "list" })
        ' Thumbs up / down (pressing the chosen one again clears it).
        thumb = mqNum(x.thumb)
        if thumb = 1 then m.actions.Push({ label: "Liked (undo)", act: "thumb", value: 0 }) else m.actions.Push({ label: "I like this", act: "thumb", value: 1 })
        if thumb = -1 then m.actions.Push({ label: "Not for me (undo)", act: "thumb", value: 0 }) else m.actions.Push({ label: "Not for me", act: "thumb", value: -1 })
    end if
    watched = false
    if kind = "show" then
        watched = mqNum(x.episodeCount) > 0 and mqNum(x.unwatchedCount) = 0
    else if x.progress <> invalid then
        watched = mqIsTrue(x.progress.watched)
    end if
    m.watched = watched
    if watched then m.actions.Push({ label: "Mark unwatched", act: "watched" }) else m.actions.Push({ label: "Mark watched", act: "watched" })
    if kind = "episode" and x.next <> invalid then m.actions.Push({ label: "Next: " + mqEpLabel(x.next), act: "open", id: x.next.id })

    labels = []
    for each a in m.actions
        labels.Push(a.label)
    end for
    m.buttons.buttons = labels
    if m.top.isInFocusChain() then m.buttons.setFocus(true)
end sub

sub onButton()
    a = m.actions[m.buttons.buttonSelected]
    if a = invalid then return
    x = m.item
    if a.act = "play" then
        m.top.navigate = { screen: "PlayerScreen", params: { id: a.id, start: a.start } }
    else if a.act = "episodes" then
        season = invalid
        if x.upNext <> invalid then season = x.upNext.season
        m.top.navigate = { screen: "EpisodesScreen", params: { id: x.id, title: x.title, season: season } }
    else if a.act = "open" then
        m.top.navigate = { screen: "DetailsScreen", params: { id: a.id, kind: "episode" }, replace: true }
    else if a.act = "list" then
        method = "PUT"
        if mqIsTrue(x.inWatchlist) then method = "DELETE"
        mqApi("/api/watchlist/" + x.id, "onChanged", method)
    else if a.act = "thumb" then
        mqApi("/api/thumbs/" + x.id, "onChanged", "PUT", { value: a.value })
    else if a.act = "watched" then
        if x.type = "show" then
            mqApi("/api/shows/" + x.id + "/watched", "onChanged", "POST", { watched: not m.watched })
        else
            mqApi("/api/items/" + x.id + "/watched", "onChanged", "POST", { watched: not m.watched })
        end if
    end if
end sub

sub onChanged()
    load()
end sub
