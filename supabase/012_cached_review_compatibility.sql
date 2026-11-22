create or replace function flashback_private.require_rejection_reason()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'rejected' and old.status is distinct from new.status then
    -- Cached client versions still submit a blank note.
    new.review_note := coalesce(nullif(btrim(new.review_note), ''), '管理员未填写理由。');
    if char_length(new.review_note) not between 2 and 200 then
      raise exception '拒绝理由需要 2–200 个字符';
    end if;
  end if;
  return new;
end;
$$;
