#ifndef __RARCH_STATE_LABELS_H
#define __RARCH_STATE_LABELS_H

#include <stddef.h>
#include <boolean.h>

bool state_labels_get_label_for_slot(int slot, char *label, size_t len);
bool state_labels_get_display_for_slot(int slot, char *label, size_t len);
bool state_labels_set_label_for_slot(int slot, const char *label);

#endif
